const fs = require('fs');
const path = require('path');

class Inventory {
    /**
     * @param {string} myStickerId - Figurinha autoral do aluno
     * @param {string} [filePath]  - Caminho do arquivo JSON para persistência
     */
    constructor(myStickerId, filePath) {
        this.myStickerId = myStickerId;
        this.filePath = filePath || path.join(process.cwd(), 'inventory.json');

        // Tenta carregar do arquivo; se não existir, inicia com 28 cópias
        if (fs.existsSync(this.filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                this.items = data;
                console.log(`[Inventário] Carregado de ${this.filePath}`);
            } catch (e) {
                console.log(`[Inventário] Erro ao ler ${this.filePath}, iniciando novo inventário.`);
                this.items = { [myStickerId]: 28 };
                this._save();
            }
        } else {
            this.items = { [myStickerId]: 28 };
            this._save();
        }
    }

    _save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.items, null, 2), 'utf-8');
        } catch (e) {
            console.error(`[Inventário] Erro ao salvar: ${e.message}`);
        }
    }

    has(stickerId) {
        return (this.items[stickerId] || 0) > 0;
    }

    add(stickerId, qty = 1) {
        this.items[stickerId] = (this.items[stickerId] || 0) + qty;
        this._save();
    }

    remove(stickerId, qty = 1) {
        if (!this.has(stickerId)) throw new Error("Sem estoque");
        this.items[stickerId] -= qty;
        if (this.items[stickerId] <= 0) {
            delete this.items[stickerId];
        }
        this._save();
    }

    getAll() {
        return { ...this.items };
    }

    getQuantity(stickerId) {
        return this.items[stickerId] || 0;
    }
}

module.exports = Inventory;