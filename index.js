// Aceita config via argumento: node index.js config.node2.json
// Se não informado, usa config.json por padrão
const configFile = process.argv[2] || './config.json';
const config = require(configFile.startsWith('.') ? configFile : `./${configFile}`);
const P2PNode = require('./src/node');
const startCLI = require('./src/cli');

const node = new P2PNode(config);

// Callback chamado quando um SEARCH_HIT chega
node.onSearchResult = (msg) => {
    console.log(`\n✅ Figurinha encontrada: ${msg.sticker_id} | Peer: ${msg.origin_peer_id}\n`);
};

node.start();
startCLI(node);