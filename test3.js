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
const WORKERS_PER_SENDER = 15;
const BATCH_SIZE = 30;
const MAX_TPS_TARGET = 4000;
const RATE_LIMIT_DELAY_MS = 7;
const CHAIN_TPS_INTERVAL = 10000;
const GOSSIP_REFRESH_INTERVAL = 300000;

// Fixed endpoints
const X1_TESTNET_RPC = 'https://rpc.testnet.x1.xyz';
const FALLBACK_ENDPOINTS = [
  X1_TESTNET_RPC,
  'http://173.249.26.21:8899',
  'http://68.168.213.6:8899',
  'http://173.214.172.170:8899',
  'http://74.50.76.178:8899',
  'http://65.109.112.35:8899',
  'http://65.108.134.100:8899'
];

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

let RPC_ENDPOINTS = [...FALLBACK_ENDPOINTS];

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

// ===== RPC DISCOVERY =====
async function discoverX1RpcEndpoints() {
  try {
    const bootstrapConnection = new Connection(X1_TESTNET_RPC);
    const nodes = await bootstrapConnection.getClusterNodes();
    
    const rpcNodes = nodes.filter(node => {
      const hasGossip = node.gossip && node.gossip.includes(':');
      const hasRpc = node.rpc && node.rpc.includes(':');
      return hasGossip && hasRpc;
    });
    
    let endpoints = rpcNodes.map(node => {
      const [host, port] = node.rpc.split(':');
      return `http://${host}:${port}`;
    });
    
    endpoints = endpoints.filter(url => url.startsWith('http'));
    endpoints = shuffleArray(endpoints);
    
    const randomEndpoints = [...new Set(endpoints)].slice(0, 9);
    return [X1_TESTNET_RPC, ...randomEndpoints];
  } catch (error) {
    console.error('Failed to discover RPC endpoints from X1 gossip:', error.message);
    return FALLBACK_ENDPOINTS;
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// ===== CHAIN TPS MONITOR =====
async function monitorChainTps(connection) {
  try {
    const samples = await connection.getRecentPerformanceSamples(5);
    const latestSample = samples[0];
    
    if (latestSample && latestSample.numTransactions) {
      stats.chainTps = (latestSample.numTransactions / 60).toFixed(2);
      return;
    }

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
    RPC_ENDPOINTS = await discoverX1RpcEndpoints();
    
    const SENDERS = await getSenderConfig();
    console.log(`Launching ${SENDERS.length * WORKERS_PER_SENDER} workers`);

    // Worker distribution function
    const distributeWorkers = () => {
      const totalWorkers = SENDERS.length * WORKERS_PER_SENDER;
      const workersPerRpc = Math.floor(totalWorkers / RPC_ENDPOINTS.length);
      let remainder = totalWorkers % RPC_ENDPOINTS.length;

      const rpcAssignments = [];
      RPC_ENDPOINTS.forEach(rpc => {
        const count = workersPerRpc + (remainder-- > 0 ? 1 : 0);
        rpcAssignments.push(...Array(count).fill(rpc));
      });

      return shuffleArray(rpcAssignments);
    };

    let rpcAssignments = distributeWorkers();

    // Show initial worker distribution with full URLs
    console.log("\nInitial Worker Distribution:");
    const distributionSummary = {};
    rpcAssignments.forEach(rpc => {
      distributionSummary[rpc] = (distributionSummary[rpc] || 0) + 1;
    });
    console.table(Object.entries(distributionSummary).map(([rpc, count]) => ({
      RPC: rpc,
      Workers: count,
      'Percentage': `${((count / rpcAssignments.length) * 100).toFixed(1)}%`
    })));

    const monitorConnection = new Connection(X1_TESTNET_RPC, 'confirmed');
    setInterval(() => monitorChainTps(monitorConnection), CHAIN_TPS_INTERVAL);
    setInterval(logStats, 10000);

    let workerCounter = 0;
    const workers = [];
    
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

        workers.push(worker);
      }
    });

    // Silent RPC refresh
    setInterval(async () => {
      try {
        await discoverX1RpcEndpoints();
      } catch (e) {
        // Failures are handled by individual workers
      }
    }, GOSSIP_REFRESH_INTERVAL);

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

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;
    const BASE_BACKOFF_MS = 1000;

    const switchRpc = async () => {
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
        
        try {
          await connection.getLatestBlockhash();
          consecutiveFailures = 0;
          return true;
        } catch (testError) {
          // Silent fail for testing RPCs
        }
        
        if (attempts >= maxAttempts) {
          const backoffTime = Math.min(
            BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures),
            30000
          );
          consecutiveFailures = Math.min(consecutiveFailures + 1, MAX_CONSECUTIVE_FAILURES);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
          return false;
        }
      } while (currentRpcIndex === originalIndex);
      
      return true;
    };

    while (true) {
      try {
        let blockhash;
        try {
          ({ blockhash } = await connection.getLatestBlockhash());
          consecutiveFailures = 0;
        } catch (err) {
          if (!await switchRpc()) {
            continue;
          }
          continue;
        }

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

        await new Promise(resolve => setTimeout(resolve, rateLimitDelay));

      } catch (err) {
        parentPort.postMessage({ status: 'fail', rpcUsed: allRpcEndpoints[currentRpcIndex] });
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  })();
}
