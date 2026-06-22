const { v4: uuidv4 } = require('uuid');

// Funções que montam cada tipo de mensagem conforme o padrão de interoperabilidade
const Protocol = {

    // HELLO: anuncia presença e compartilha lista de peers conhecidos
    hello(senderPeerId, knownPeers = []) {
        return {
            type: 'HELLO',
            message_id: uuidv4(),
            sender_peer_id: senderPeerId,
            peers: knownPeers
        };
    },

    // SEARCH: busca por inundação com TTL e query_id para supressão de duplicatas
    search({ originPeerId, originPeerIp, senderPeerId, receiverPeerId, queryId, stickerId, ttl = 7 }) {
        return {
            type: 'SEARCH',
            message_id: uuidv4(),
            origin_peer_id: originPeerId,
            origin_peer_ip: originPeerIp || '',
            sender_peer_id: senderPeerId,
            receiver_peer_id: receiverPeerId,
            query_id: queryId || uuidv4(),
            ttl,
            sticker_id: stickerId
        };
    },

    // SEARCH_HIT: resposta positiva — nó local possui a figurinha
    searchHit({ originPeerId, senderPeerId, receiverPeerId, queryId, stickerId }) {
        return {
            type: 'SEARCH_HIT',
            message_id: uuidv4(),
            origin_peer_id: originPeerId,
            sender_peer_id: senderPeerId,
            receiver_peer_id: receiverPeerId,
            query_id: queryId,
            sticker_id: stickerId
        };
    },

    // SEARCH_MISS: resposta opcional — nó local não possui a figurinha
    searchMiss({ originPeerId, senderPeerId, receiverPeerId, queryId, stickerId }) {
        return {
            type: 'SEARCH_MISS',
            message_id: uuidv4(),
            origin_peer_id: originPeerId,
            sender_peer_id: senderPeerId,
            receiver_peer_id: receiverPeerId,
            query_id: queryId,
            sticker_id: stickerId
        };
    },

    // TRADE_OFFER: propõe troca direta após SEARCH_HIT
    tradeOffer({ originPeerId, senderPeerId, receiverPeerId, offerStickerId, wantStickerId }) {
        return {
            type: 'TRADE_OFFER',
            message_id: uuidv4(),
            origin_peer_id: originPeerId,
            sender_peer_id: senderPeerId,
            receiver_peer_id: receiverPeerId,
            offer_sticker_id: offerStickerId,
            want_sticker_id: wantStickerId
        };
    },

    // TRADE_ACCEPT: aceita a troca proposta
    tradeAccept({ originPeerId, senderPeerId, receiverPeerId, offerStickerId, wantStickerId }) {
        return {
            type: 'TRADE_ACCEPT',
            message_id: uuidv4(),
            origin_peer_id: originPeerId,
            sender_peer_id: senderPeerId,
            receiver_peer_id: receiverPeerId,
            offer_sticker_id: offerStickerId,
            want_sticker_id: wantStickerId
        };
    },

    // TRADE_REJECT: rejeita a troca proposta
    tradeReject({ originPeerId, senderPeerId, receiverPeerId, offerStickerId, wantStickerId, reason }) {
        return {
            type: 'TRADE_REJECT',
            message_id: uuidv4(),
            origin_peer_id: originPeerId,
            sender_peer_id: senderPeerId,
            receiver_peer_id: receiverPeerId,
            offer_sticker_id: offerStickerId,
            want_sticker_id: wantStickerId,
            reason: reason || ''
        };
    },

    // TRANSFER_CONFIRM: confirma atualização do inventário após troca
    transferConfirm({ originPeerId, senderPeerId, receiverPeerId, offerStickerId, wantStickerId }) {
        return {
            type: 'TRANSFER_CONFIRM',
            message_id: uuidv4(),
            origin_peer_id: originPeerId,
            sender_peer_id: senderPeerId,
            receiver_peer_id: receiverPeerId,
            offer_sticker_id: offerStickerId,
            want_sticker_id: wantStickerId
        };
    }
};

module.exports = Protocol;