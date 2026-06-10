class Inventory {
    constructor(myStickerId) {
        // 28 cópias iniciais
        this.items = { [myStickerId]: 28 };
    }

    has(stickerId) {
        return (this.items[stickerId] || 0) > 0;
    }

    add(stickerId, qty = 1) {
        this.items[stickerId] = (this.items[stickerId] || 0) + qty;
    }

    remove(stickerId, qty = 1) {
        if (!this.has(stickerId)) throw new Error("Sem estoque");
        this.items[stickerId] -= qty;
    }

    getAll() {
        return { ...this.items };
    }
}

module.exports = Inventory;