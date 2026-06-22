const readline = require('readline');

function startCLI(node) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\nComandos disponíveis:');
    console.log('  inv                          - ver inventário');
    console.log('  search FIG-XX                - buscar figurinha');
    console.log('  trade ALUNO-XX FIG-XX FIG-YY - propor troca (peer, ofereço, quero)');
    console.log('  connect HOST PORTA           - conectar a vizinho');
    console.log('  peers                        - ver peers conectados');
    console.log('  history                      - ver histórico de trocas\n');

    rl.on('line', (line) => {
        const parts = line.trim().split(' ');
        const cmd = parts[0];

        if (cmd === 'inv') {
            node.showInventory();
        } else if (cmd === 'search' && parts[1]) {
            node.search(parts[1]);
        } else if (cmd === 'trade' && parts.length === 4) {
            node.offerTrade(parts[1], parts[2], parts[3]);
        } else if (cmd === 'connect' && parts.length === 3) {
            node._connectTo(parts[1], parseInt(parts[2]));
        } else if (cmd === 'peers') {
            console.log('Peers conectados:', [...node.connections.keys()]);
        } else if (cmd === 'history') {
            node.showHistory();
        } else {
            console.log('Comando não reconhecido.');
        }
    });
}

module.exports = startCLI;