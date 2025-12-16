const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Serveur HTTP pour Render
const server = http.createServer();
const wss = new WebSocket.Server({ server });
// Après la création du serveur WebSocket
wss.on('headers', (headers, req) => {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, POST';
});
// Stockage des connexions
const connections = new Map();
const userRooms = new Map();

wss.on('connection', (ws, request) => {
    const parameters = url.parse(request.url, true);
    const userId = parameters.query.userId;
    
    if (!userId) {
        ws.close(1008, 'User ID required');
        return;
    }
    
    console.log(`Nouvelle connexion: ${userId}`);
    
    // Stocker la connexion
    connections.set(userId, ws);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(userId, message);
        } catch (error) {
            console.error('Erreur parsing message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`Déconnexion: ${userId}`);
        connections.delete(userId);
        
        // Notifier les contacts que l'utilisateur est hors ligne
        broadcastToContacts(userId, {
            type: 'user-offline',
            userId: userId
        });
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${userId}:`, error);
    });
    
    // Envoyer la confirmation de connexion
    ws.send(JSON.stringify({
        type: 'connected',
        timestamp: Date.now()
    }));
});

function handleMessage(senderId, message) {
    console.log(`Message de ${senderId}:`, message.type);
    
    switch (message.type) {
        case 'call':
            handleCall(senderId, message);
            break;
            
        case 'answer':
            handleAnswer(senderId, message);
            break;
            
        case 'ice-candidate':
            handleIceCandidate(senderId, message);
            break;
            
        case 'decline-call':
            handleDeclineCall(senderId, message);
            break;
            
        case 'end-call':
            handleEndCall(senderId, message);
            break;
            
        case 'chat-message':
            handleChatMessage(senderId, message);
            break;
            
        case 'typing':
            handleTyping(senderId, message);
            break;
            
        case 'ping':
            // Répondre au ping pour maintenir la connexion
            const ws = connections.get(senderId);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
            break;
    }
}

function handleCall(callerId, message) {
    const { targetId, offer, callerName } = message;
    const targetWs = connections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'incoming-call',
            callerId: callerId,
            callerName: callerName || callerId,
            offer: offer,
            timestamp: Date.now()
        }));
        
        // Confirmer au caller que l'appel a été envoyé
        const callerWs = connections.get(callerId);
        if (callerWs) {
            callerWs.send(JSON.stringify({
                type: 'call-sent',
                targetId: targetId
            }));
        }
    } else {
        // Cible non connectée
        const callerWs = connections.get(callerId);
        if (callerWs) {
            callerWs.send(JSON.stringify({
                type: 'user-offline',
                userId: targetId
            }));
        }
    }
}

function handleAnswer(answererId, message) {
    const { callerId, answer } = message;
    const callerWs = connections.get(callerId);
    
    if (callerWs && callerWs.readyState === WebSocket.OPEN) {
        callerWs.send(JSON.stringify({
            type: 'call-answered',
            answererId: answererId,
            answer: answer
        }));
        
        // Créer une salle pour les deux utilisateurs
        const roomId = [callerId, answererId].sort().join('_');
        userRooms.set(callerId, roomId);
        userRooms.set(answererId, roomId);
    }
}

function handleIceCandidate(senderId, message) {
    const { targetId, candidate } = message;
    const targetWs = connections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'ice-candidate',
            senderId: senderId,
            candidate: candidate
        }));
    }
}

function handleDeclineCall(declinerId, message) {
    const { callerId } = message;
    const callerWs = connections.get(callerId);
    
    if (callerWs && callerWs.readyState === WebSocket.OPEN) {
        callerWs.send(JSON.stringify({
            type: 'call-declined',
            declinerId: declinerId
        }));
    }
}

function handleEndCall(enderId, message) {
    const { targetId } = message;
    const targetWs = connections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'call-ended',
            enderId: enderId
        }));
    }
    
    // Supprimer la salle
    userRooms.delete(enderId);
    userRooms.delete(targetId);
}

function handleChatMessage(senderId, message) {
    const { targetId, content } = message;
    const targetWs = connections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'chat-message',
            senderId: senderId,
            content: content,
            timestamp: Date.now()
        }));
    }
}

function handleTyping(senderId, message) {
    const { targetId, isTyping } = message;
    const targetWs = connections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'typing',
            senderId: senderId,
            isTyping: isTyping
        }));
    }
}

function broadcastToContacts(userId, message) {
    // Dans une implémentation réelle, vous récupéreriez les contacts depuis la DB
    // Pour l'exemple, on broadcast à tous sauf à l'utilisateur
    connections.forEach((ws, id) => {
        if (id !== userId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

// Nettoyage périodique des connexions mortes
setInterval(() => {
    connections.forEach((ws, userId) => {
        if (ws.readyState !== WebSocket.OPEN) {
            connections.delete(userId);
            userRooms.delete(userId);
        }
    });
}, 30000);

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});

// Gérer la fermeture propre
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    wss.close(() => {
        server.close(() => {
            process.exit(0);
        });
    });

});
