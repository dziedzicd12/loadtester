# X1 Load Tester (`test.js`)

A high-performance Solana transaction load testing tool designed to stress test RPC endpoints and measure network throughput.

## Features

- 🚀 Multi-threaded transaction sending
- 🔀 Automatic RPC failover and load balancing
- 📊 Real-time performance monitoring
- ⚖️ Configurable rate limiting
- 📈 Chain TPS measurement
- 🔑 Supports multiple sender accounts

## Installation

1. Clone this repository
2. Install dependencies:
```bash
npm install @solana/web3.js
```

## Configuration

Create or modify `sender_config.json` to configure your test parameters:

### Main Configuration Options

```json
{
  "rpcEndpoints": [
    "https://primary.rpc.url",
    "https://fallback.rpc.url"
  ],
  "workersPerSender": 5,
  "batchSize": 20,
  "maxTpsTarget": 2000,
  "rateLimitDelayMs": 15,
  "monitoringInterval": 5000
}
```

### Sender and Recipient Accounts Configuration

The first time you run the script, it will prompt you enter the paths to four funded wallet to create `sender_config.json'. The recipient public address is generated from the sender path you input.

```json
[
  {
    "keypairPath": "~/path/to/keypair1.json",
    "recipient": "RECIPIENT_ADDRESS_1",
    "label": "Sender1"
  },
  {
    "keypairPath": "~/path/to/keypair2.json",
    "recipient": "RECIPIENT_ADDRESS_2",
    "label": "Sender2"
  }
]
```

## Runtime Configuration

You can adjust these parameters by editing the variables at the top of `test.js`:

```javascript
// ===== CONFIGURATION =====
const WORKERS_PER_SENDER = 10;    // Number of worker threads per sender
const BATCH_SIZE = 20;            // Transactions per batch
const MAX_TPS_TARGET = 3000;      // Maximum target transactions per second
const RATE_LIMIT_DELAY_MS = 10;   // Delay between batches (ms)
const CHAIN_TPS_INTERVAL = 5000;  // How often to check chain TPS (ms)
```

## Usage

```bash
node test.js
```

The script will:
1. Load or create configuration
2. Distribute workers across RPC endpoints
3. Begin sending transactions
4. Display real-time statistics

## Performance Metrics

The script outputs:
- Your application TPS (transactions per second)
- Network TPS (measured from chain data)
- Success/failure rates
- Top performing RPC endpoints

## Customization Options

### Transaction Content
Modify the worker thread section to change transaction types:
```javascript
// In worker thread section:
tx.add(
  SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: new PublicKey(recipientAddress),
    lamports: Math.floor(Math.random() * 100) + 1
  })
);
```

### RPC Selection
Edit the `RPC_ENDPOINTS` array to use your preferred endpoints.

## Troubleshooting

**Common Issues:**
- `Invalid keypair` - Ensure your keypair paths are correct
- `RPC failures` - Verify your endpoints are accessible
- `Low TPS` - Try reducing batch size or increasing workers

## License

MIT License - Free for personal and commercial use
