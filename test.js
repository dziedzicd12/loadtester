const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const fs = require('fs');
const { execSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');

// ===== CONFIGURATION =====
const CONFIG_PATH = './sender_config.json';
const RPC_ENDPOINTS = [
  'https://rpc.testnet.x1.xyz',
  'http://76.18.85.176:8899',
  'http://66.23.234.2:8899',
  'http://206.72.198.218:8899',
  'http://162.238.215.35:8899',
  'http://212.237.217.29:8899',
  'http://38.58.179.51:8899',
  'http://74.50.77.86:8899'
].map(url => url.startsWith('http') ? url : `http://${url}`);

const WORKERS_PER_SENDER = 12;
const BATCH_SIZE = 40;
const MAX_TPS_TARGET = 20000;
const RATE_LIMIT_DELAY_MS = 13;

// ===== PERFORMANCE TRACKING =====
let stats = {
  totalBatches: 0,
  successCount: 0,
  failCount: 0,
  lastReset: Date.now(),
  rpcUsage: {} // Track RPC performance
};

// ===== HELPER FUNCTIONS =====
function expandPath(filepath) {
  return filepath.replace('~', os.homedir());
}

async function getSenderConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).map(s => ({
      ...s,
      keypairPath: expandPath(s.keypairPath)
    }));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const senders = [];

  for (let i = 0; i < 4; i++) {
    const keypairPath = expandPath(await new Promise(resolve => 
      rl.question(`Path to sender ${i+1} keypair: `, resolve)
    ));

    try {
      const recipient = execSync(`solana-keygen pubkey "${keypairPath}"`).toString().trim();
      senders.push({
        keypairPath,
        recipient,
        label: `Sender${i+1}`
        // Removed assignedRpc to enable dynamic distribution
      });
    } catch {
      console.error(`Invalid keypair for sender ${i+1}. Retry.`);
      i--;
    }
  }

  rl.close();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(senders, null, 2));
  return senders;
}

// ===== STATS LOGGER =====
function logStats() {
  const elapsedSec = (Date.now() - stats.lastReset) / 1000;
  const tps = ((stats.successCount * BATCH_SIZE) / elapsedSec).toFixed(2);
  
  console.log(`
=== MAX-TPS METRICS ===
TPS: ${tps} (${stats.successCount * BATCH_SIZE} TXs in ${elapsedSec}s)
Success Rate: ${(stats.successCount / (stats.successCount + stats.failCount) * 100).toFixed(2)}%
Failures: ${stats.failCount}

RPC Performance:
${Object.entries(stats.rpcUsage).map(([rpc, count]) => 
  `• ${rpc}: ${count} TXs`).join('\n')}
========================
`);

  stats.successCount = stats.failCount = 0;
  stats.lastReset = Date.now();
  stats.rpcUsage = {};
}

// ===== MAIN THREAD =====
if (isMainThread) {
  (async () => {
    const SENDERS = await getSenderConfig();
    console.log(`?? Launching ${SENDERS.length * WORKERS_PER_SENDER} workers across ${RPC_ENDPOINTS.length} RPCs`);

    // Calculate workers per RPC for even distribution
    const totalWorkers = SENDERS.length * WORKERS_PER_SENDER;
    const workersPerRpc = Math.floor(totalWorkers / RPC_ENDPOINTS.length);
    const remainder = totalWorkers % RPC_ENDPOINTS.length;

    const rpcAssignments = [];
    RPC_ENDPOINTS.forEach((rpc, i) => {
      const count = workersPerRpc + (i < remainder ? 1 : 0);
      rpcAssignments.push(...Array(count).fill(rpc));
    });

    console.log("\n?? RPC Worker Distribution:");
    const distributionSummary = {};
    rpcAssignments.forEach(rpc => {
      distributionSummary[rpc] = (distributionSummary[rpc] || 0) + 1;
    });
    console.table(distributionSummary);

    setInterval(logStats, 10000);

    let workerCounter = 0;
    SENDERS.forEach(sender => {
      for (let i = 0; i < WORKERS_PER_SENDER; i++) {
        const assignedRpc = rpcAssignments[workerCounter % rpcAssignments.length];
        workerCounter++;

        const worker = new Worker(__filename, {
          workerData: {
            keypairPath: sender.keypairPath,
            recipientAddress: sender.recipient,
            primaryRpc: assignedRpc,
            allRpcEndpoints: RPC_ENDPOINTS,
            batchSize: BATCH_SIZE,
            rateLimitDelay: RATE_LIMIT_DELAY_MS
          }
        });

        worker.on('message', ({ status, rpcUsed }) => {
          if (status === 'success') {
            stats.successCount++;
            stats.rpcUsage[rpcUsed] = (stats.rpcUsage[rpcUsed] || 0) + BATCH_SIZE;
          } else {
            stats.failCount++;
          }
          stats.totalBatches++;
        });
      }
    });
  })();

// ===== WORKER THREADS =====
} else {
  (async () => {
    const { 
      keypairPath, 
      recipientAddress, 
      primaryRpc,
      allRpcEndpoints,
      batchSize,
      rateLimitDelay
    } = workerData;

    const keypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8')))
    );

    let currentRpcIndex = allRpcEndpoints.indexOf(primaryRpc);
    let connection = new Connection(allRpcEndpoints[currentRpcIndex], {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
      confirmTransactionInitialTimeout: 120000
    });

    // Fail-safe RPC rotation
    const switchRpc = () => {
      const originalIndex = currentRpcIndex;
      let attempts = 0;
      
      do {
        currentRpcIndex = (currentRpcIndex + 1) % allRpcEndpoints.length;
        connection = new Connection(allRpcEndpoints[currentRpcIndex], 'confirmed');
        attempts++;
        
        if (attempts >= allRpcEndpoints.length) {
          console.error('All RPCs failed! Waiting before retry...');
          currentRpcIndex = originalIndex;
          return false;
        }
      } while (currentRpcIndex === originalIndex);
      
      return true;
    };

    while (true) {
      try {
        // 1. Get latest blockhash
        let blockhash;
        try {
          ({ blockhash } = await connection.getLatestBlockhash());
        } catch (err) {
          if (!switchRpc()) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          }
          continue;
        }

        // 2. Prepare batch TX
        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: keypair.publicKey });
        for (let i = 0; i < batchSize; i++) {
          tx.add(
            SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: new PublicKey(recipientAddress),
              lamports: Math.floor(Math.random() * 100) + 1
            })
          );
        }

        // 3. Sign & Send
        tx.sign(keypair);
        const rpcUsed = allRpcEndpoints[currentRpcIndex];
        
        sendAndConfirmTransaction(connection, tx, [keypair], {
          skipPreflight: true,
          commitment: 'confirmed'
        })
          .then(() => parentPort.postMessage({ status: 'success', rpcUsed }))
          .catch((err) => {
            parentPort.postMessage({ status: 'fail', rpcUsed });
            switchRpc();
          });

        // 4. Rate limiting
        await new Promise(resolve => setTimeout(resolve, rateLimitDelay));

      } catch (err) {
        parentPort.postMessage({ status: 'fail', rpcUsed: allRpcEndpoints[currentRpcIndex] });
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  })();
}
