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
  'http://149.86.227.119:8899',
  'http://173.249.26.21:8899',
  'http://194.50.156.179:8899',
  'http://65.108.134.100:8899',
  'http://65.109.112.35:8899',
  'http://173.214.172.170:8899',
  'http://74.50.76.2:8899',
  'http://68.168.213.6:8899',
  'http://74.50.76.62:8899',
  'http://74.50.77.86:8899',
  'http://owlnet.dev:8000',
  'http://rpc-testnet.x1.wiki:8899',
  'http://38.129.136.5:8899'
].map(url => url.startsWith('http') ? url : `http://${url}`);

const WORKERS_PER_SENDER = 8;
const BATCH_SIZE = 2;
const MAX_TPS_TARGET = 1000;
const RATE_LIMIT_DELAY_MS = 0;
const CHAIN_TPS_INTERVAL = 5000; // Check on-chain TPS every 10 seconds

// ===== PERFORMANCE TRACKING =====
let stats = {
  totalBatches: 0,
  successCount: 0,
  failCount: 0,
  lastReset: Date.now(),
  rpcUsage: {},
  chainTps: 0,
  lastSlot: 0,
  lastTxCount: 0
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

// ===== CHAIN TPS MONITOR =====
async function monitorChainTps(connection) {
  try {
    // Method 1: Direct from recent performance samples
    const samples = await connection.getRecentPerformanceSamples(5); // Last 5 samples
    const latestSample = samples[0];
    
    if (latestSample && latestSample.numTransactions) {
      // Each sample covers ~60 seconds
      stats.chainTps = (latestSample.numTransactions / 60).toFixed(2);
      return;
    }

    // Fallback Method 2: Block-based calculation
    const block = await connection.getLatestBlockhash();
    const blockInfo = await connection.getBlock(block.lastValidBlockHeight, {
      maxSupportedTransactionVersion: 0,
      transactionDetails: 'none'
    });
    
    if (blockInfo && blockInfo.blockTime && blockInfo.previousBlockhash) {
      const prevBlock = await connection.getBlock(blockInfo.previousBlockhash, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: 'none'
      });
      
      if (prevBlock && prevBlock.blockTime) {
        const timeDiff = blockInfo.blockTime - prevBlock.blockTime;
        const txsInBlock = blockInfo.transactions?.length || 0;
        stats.chainTps = timeDiff > 0 ? (txsInBlock / timeDiff).toFixed(2) : "N/A";
      }
    }
  } catch (err) {
    console.error('Chain TPS monitoring error:', err.message);
    stats.chainTps = "Error";
  }
}

// ===== STATS LOGGER =====
function logStats() {
  const elapsedSec = (Date.now() - stats.lastReset) / 1000;
  const ourTps = ((stats.successCount * BATCH_SIZE) / elapsedSec).toFixed(2);
  
  console.log(`
=== PERFORMANCE METRICS ===
Our TPS: ${ourTps} (${stats.successCount * BATCH_SIZE} TXs in ${elapsedSec}s)
Chain TPS: ${stats.chainTps} (observed)
Success Rate: ${(stats.successCount / (stats.successCount + stats.failCount) * 100).toFixed(2)}%
Failures: ${stats.failCount}

Top RPCs by Volume:
${Object.entries(stats.rpcUsage)
  .sort((a,b) => b[1]-a[1])
  .slice(0,5)
  .map(([rpc, count]) => `• ${rpc}: ${count} TXs`).join('\n')}
==========================
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

    // Create monitoring connection
    const monitorConnection = new Connection(RPC_ENDPOINTS[0], 'confirmed');
    setInterval(() => monitorChainTps(monitorConnection), CHAIN_TPS_INTERVAL);

    // Calculate optimal distribution
    const totalWorkers = SENDERS.length * WORKERS_PER_SENDER;
    const workersPerRpc = Math.floor(totalWorkers / RPC_ENDPOINTS.length);
    let remainder = totalWorkers % RPC_ENDPOINTS.length;

    const rpcAssignments = [];
    RPC_ENDPOINTS.forEach(rpc => {
      const count = workersPerRpc + (remainder-- > 0 ? 1 : 0);
      rpcAssignments.push(...Array(count).fill(rpc));
    });

    // Shuffle for better initial distribution
    for (let i = rpcAssignments.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rpcAssignments[i], rpcAssignments[j]] = [rpcAssignments[j], rpcAssignments[i]];
    }

    console.log("\n?? RPC Worker Distribution:");
    const distributionSummary = {};
    rpcAssignments.forEach(rpc => {
      distributionSummary[rpc] = (distributionSummary[rpc] || 0) + 1;
    });
    console.table(Object.entries(distributionSummary).map(([rpc, count]) => ({
      RPC: rpc,
      Workers: count,
      'Percentage': `${((count / totalWorkers) * 100).toFixed(1)}%`
    })));

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

    // Enhanced failover with weighted retry
    const switchRpc = () => {
      const originalIndex = currentRpcIndex;
      let attempts = 0;
      const maxAttempts = allRpcEndpoints.length * 2;
      
      do {
        currentRpcIndex = (currentRpcIndex + 1) % allRpcEndpoints.length;
        connection = new Connection(allRpcEndpoints[currentRpcIndex], {
          commitment: 'confirmed',
          disableRetryOnRateLimit: false
        });
        attempts++;
        
        if (attempts >= maxAttempts) {
          console.error('Critical: All RPCs failing. Waiting 10s...');
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
            await new Promise(resolve => setTimeout(resolve, 10000));
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
          commitment: 'confirmed',
          maxRetries: 3
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
