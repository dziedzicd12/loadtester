const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  clusterApiUrl,
} = require('@solana/web3.js');
const fs = require('fs');
const { execSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ===== CONFIGURATION =====
const CONFIG_PATH = './sender_config.json';
const RPC_CACHE_PATH = './rpc_cache.json';
const HARDCODED_RPCS = [
  'https://rpc.testnet.x1.xyz',
  'http://173.249.26.21:8899',
  'http://68.168.213.6:8899',
  'http://173.214.172.170:8899',
  'http://74.50.76.178:8899',
  'http://65.109.112.35:8899',
  'http://65.108.134.100:8899',
  'http://74.50.77.86:8899',
  'http://66.23.234.2:8899',
  'http://74.50.76.62:8899',
  'http://152.53.33.214:8899',
  'http://74.50.76.2:8899',
  'http://185.54.58.162:8899',
  'http://64.20.46.74:8899',
  'http://149.86.227.119:8899'
].map(url => url.startsWith('http') ? url : `http://${url}`);

const WORKERS_PER_SENDER = 15;
const BATCH_SIZE = 30;
const MAX_TPS_TARGET = 4000;
const RATE_LIMIT_DELAY_MS = 0;
const CHAIN_TPS_INTERVAL = 10000;
const MAX_ACTIVE_RPCS = 20;
const RPC_TEST_TIMEOUT = 2000;
const GOSSIP_REFRESH_INTERVAL = 3600000; // 1 hour

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

// ===== RPC MANAGER =====
class RpcManager {
  constructor() {
    this.activeRpcs = [];
    this.allRpcs = [];
    this.currentIndex = 0;
    this.lastGossipUpdate = 0;
  }

  async initialize() {
    await this.loadCachedRpcs();
    if (Date.now() - this.lastGossipUpdate > GOSSIP_REFRESH_INTERVAL || this.allRpcs.length < MAX_ACTIVE_RPCS) {
      await this.discoverRpcsViaGossip();
    }
    await this.selectActiveRpcs();
  }

  async loadCachedRpcs() {
    try {
      if (fs.existsSync(RPC_CACHE_PATH)) {
        const cached = JSON.parse(fs.readFileSync(RPC_CACHE_PATH, 'utf8'));
        this.allRpcs = [...new Set([...cached, ...HARDCODED_RPCS])];
        console.log(`Loaded ${this.allRpcs.length} RPCs from cache`);
      } else {
        this.allRpcs = [...HARDCODED_RPCS];
      }
    } catch (e) {
      console.error('Error loading RPC cache:', e);
      this.allRpcs = [...HARDCODED_RPCS];
    }
  }

  async discoverRpcsViaGossip() {
    return new Promise((resolve) => {
      console.log('Discovering RPCs via Solana gossip...');
      const solanaGossip = spawn('solana', ['gossip', '--output', 'json']);

      let output = '';
      let error = '';

      solanaGossip.stdout.on('data', (data) => {
        output += data.toString();
      });

      solanaGossip.stderr.on('data', (data) => {
        error += data.toString();
      });

      solanaGossip.on('close', async (code) => {
        if (code === 0) {
          try {
            const nodes = JSON.parse(output);
            const newRpcs = nodes
              .filter(node => node.rpc && node.rpc !== '0.0.0.0')
              .map(node => {
                const [host] = node.rpc.split(':');
                return `http://${host}:8899`; // Standard RPC port
              });

            this.allRpcs = [...new Set([...this.allRpcs, ...newRpcs])];
            fs.writeFileSync(RPC_CACHE_PATH, JSON.stringify(this.allRpcs, null, 2));
            this.lastGossipUpdate = Date.now();
            console.log(`Discovered ${newRpcs.length} new RPCs, total: ${this.allRpcs.length}`);
          } catch (e) {
            console.error('Failed to parse gossip output:', e);
          }
        } else {
          console.error('Solana gossip command failed:', error);
        }
        resolve();
      });
    });
  }

  async testRpc(rpcUrl) {
    try {
      const testConnection = new Connection(rpcUrl, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        confirmTransactionInitialTimeout: RPC_TEST_TIMEOUT
      });
      
      const slot = await Promise.race([
        testConnection.getSlot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), RPC_TEST_TIMEOUT))
      ]);
      
      return slot > 0;
    } catch {
      return false;
    }
  }

  async selectActiveRpcs() {
    console.log('Testing and selecting active RPCs...');
    const shuffled = [...this.allRpcs].sort(() => Math.random() - 0.5);
    const testedRpcs = [];
    
    // Test RPCs in parallel with limit
    const testPromises = [];
    const concurrentTests = 5;
    
    for (let i = 0; i < shuffled.length && testedRpcs.length < MAX_ACTIVE_RPCS; i += concurrentTests) {
      const batch = shuffled.slice(i, i + concurrentTests);
      const batchTests = batch.map(async (rpc) => {
        if (await this.testRpc(rpc)) {
          testedRpcs.push(rpc);
        }
      });
      
      await Promise.all(batchTests);
    }

    this.activeRpcs = testedRpcs.slice(0, MAX_ACTIVE_RPCS);
    
    if (this.activeRpcs.length === 0) {
      console.warn('No working RPCs found, falling back to hardcoded');
      this.activeRpcs = [...HARDCODED_RPCS];
    }
    
    console.log(`Selected ${this.activeRpcs.length} active RPCs`);
  }

  getNextRpc() {
    this.currentIndex = (this.currentIndex + 1) % this.activeRpcs.length;
    return this.activeRpcs[this.currentIndex];
  }

  async handleRpcFailure(failedRpc) {
    console.log(`RPC failed: ${failedRpc}, finding replacement...`);
    
    // First try to find a replacement from our known RPCs
    for (const rpc of this.allRpcs) {
      if (!this.activeRpcs.includes(rpc)) {
        if (await this.testRpc(rpc)) {
          const index = this.activeRpcs.indexOf(failedRpc);
          if (index !== -1) {
            this.activeRpcs[index] = rpc;
            console.log(`Replaced ${failedRpc} with ${rpc}`);
            return true;
          }
        }
      }
    }
    
    // If no replacement found, try rediscovering
    if (this.activeRpcs.length < MAX_ACTIVE_RPCS / 2) {
      console.log('Low on working RPCs, rediscovering...');
      await this.discoverRpcsViaGossip();
      await this.selectActiveRpcs();
      return true;
    }
    
    return false;
  }
}

// ===== MAIN THREAD =====
if (isMainThread) {
  const rpcManager = new RpcManager();

  (async () => {
    await rpcManager.initialize();
    const SENDERS = await getSenderConfig();
    console.log(`?? Launching ${SENDERS.length * WORKERS_PER_SENDER} workers`);

    // Create monitoring connection
    const monitorConnection = new Connection(rpcManager.activeRpcs[0], 'confirmed');
    setInterval(() => monitorChainTps(monitorConnection), CHAIN_TPS_INTERVAL);
    setInterval(() => rpcManager.discoverRpcsViaGossip(), GOSSIP_REFRESH_INTERVAL);

    // Calculate worker distribution
    const totalWorkers = SENDERS.length * WORKERS_PER_SENDER;
    const workersPerRpc = Math.max(1, Math.floor(totalWorkers / rpcManager.activeRpcs.length));
    
    console.log("\n?? RPC Worker Distribution:");
    console.table(rpcManager.activeRpcs.map((rpc, i) => ({
      'RPC': rpc,
      'Workers': workersPerRpc + (i < totalWorkers % rpcManager.activeRpcs.length ? 1 : 0)
    })));

    setInterval(logStats, 10000);

    let workerCounter = 0;
    SENDERS.forEach(sender => {
      for (let i = 0; i < WORKERS_PER_SENDER; i++) {
        const assignedRpc = rpcManager.activeRpcs[workerCounter % rpcManager.activeRpcs.length];
        workerCounter++;

        const worker = new Worker(__filename, {
          workerData: {
            keypairPath: sender.keypairPath,
            recipientAddress: sender.recipient,
            primaryRpc: assignedRpc,
            allRpcEndpoints: rpcManager.activeRpcs,
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
  const rpcManager = new RpcManager();

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

    let currentRpc = primaryRpc;
    let connection = new Connection(currentRpc, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
      confirmTransactionInitialTimeout: 120000
    });

    const switchRpc = async () => {
      const newRpc = rpcManager.getNextRpc();
      if (newRpc && newRpc !== currentRpc) {
        currentRpc = newRpc;
        connection = new Connection(currentRpc, {
          commitment: 'confirmed',
          disableRetryOnRateLimit: false
        });
        return true;
      }
      return false;
    };

    while (true) {
      try {
        // Get latest blockhash
        let blockhash;
        try {
          ({ blockhash } = await connection.getLatestBlockhash());
        } catch (err) {
          if (!await switchRpc()) {
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
          continue;
        }

        // Prepare batch TX
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

        // Sign & Send
        tx.sign(keypair);
        const rpcUsed = currentRpc;
        
        sendAndConfirmTransaction(connection, tx, [keypair], {
          skipPreflight: true,
          commitment: 'confirmed',
          maxRetries: 3
        })
          .then(() => parentPort.postMessage({ status: 'success', rpcUsed }))
          .catch(async (err) => {
            parentPort.postMessage({ status: 'fail', rpcUsed });
            await switchRpc();
          });

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, rateLimitDelay));

      } catch (err) {
        parentPort.postMessage({ status: 'fail', rpcUsed: currentRpc });
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  })();
}

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
