const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Créer un serveur HTTP pour satisfaire Render
const server = http.createServer((req, res) => {
    // Route pour la santé (health check) requise par Render
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'videochat-websocket',
            timestamp: new Date().toISOString(),
            connections: connections.size
        }));
        return;
    }
    
    // Route pour les tests
    if (req.url === '/test') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WebSocket Test</title>
            </head>
            <body>
                <h1>WebSocket Server is Running</h1>
                <p>Active connections: ${connections.size}</p>
                <p>Server time: ${new Date().toISOString()}</p>
                <script>
                    const ws = new WebSocket('wss://' + window.location.host);
                    ws.onopen = () => {
                        document.body.innerHTML += '<p>WebSocket connected!</p>';
                        ws.send(JSON.stringify({type: 'test', message: 'Hello'}));
                    };
                    ws.onmessage = (e) => {
                        document.body.innerHTML += '<p>Received: ' + e.data + '</p>';
                    };
                </script>
            </body>
            </html>
        `);
        return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
});

// Créer le serveur WebSocket attaché au serveur HTTP
const wss = new WebSocket.Server({ 
    server,
    clientTracking: true,
    perMessageDeflate: {
        zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024
    }
});

// Stockage des connexions
const connections = new Map();
const userRooms = new Map();

// Gestion des connexions WebSocket
wss.on('connection', (ws, request) => {
    console.log('Nouvelle connexion WebSocket');
    
    // Extraire les paramètres de l'URL
    const parameters = url.parse(request.url, true);
    const userId = parameters.query.userId || 'anonymous_' + Date.now();
    
    console.log(`Utilisateur connecté: ${userId}`);
    
    // Stocker la connexion
    connections.set(userId, ws);
    
    // Envoyer un message de bienvenue
    ws.send(JSON.stringify({
        type: 'welcome',
        userId: userId,
        message: 'Connecté au serveur WebSocket',
        timestamp: Date.now(),
        totalConnections: connections.size
    }));
    
    // Notifier les autres utilisateurs
    broadcastUserStatus(userId, 'online');
    
    // Gestion des messages
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`Message de ${userId}:`, message.type);
            handleMessage(userId, message, ws);
        } catch (error) {
            console.error('Erreur parsing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Message JSON invalide'
            }));
        }
    });
    
    // Gestion de la fermeture
    ws.on('close', (code, reason) => {
        console.log(`Déconnexion: ${userId} (${code})`);
        connections.delete(userId);
        userRooms.delete(userId);
        
        // Notifier les autres utilisateurs
        broadcastUserStatus(userId, 'offline');
        
        // Notifier les contacts spécifiques
        notifyContacts(userId, {
            type: 'user-offline',
            userId: userId,
            timestamp: Date.now()
        });
    });
    
    // Gestion des erreurs
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${userId}:`, error);
    });
    
    // Envoyer un ping régulier pour maintenir la connexion
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
    
    ws.on('pong', () => {
        // Connexion active
    });
});

// Fonction de gestion des messages
function handleMessage(senderId, message, ws) {
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
            // Répondre au ping
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'pong',
                    timestamp: Date.now() 
                }));
            }
            break;
            
        case 'update-status':
            handleUpdateStatus(senderId, message);
            break;
            
        case 'get-users':
            handleGetUsers(senderId);
            break;
            
        default:
            console.log('Message type non reconnu:', message.type);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Type de message non reconnu: ' + message.type
                }));
            }
    }
}

// Gestion des appels
function handleCall(callerId, message) {
    const { targetId, callerName, offer } = message;
    console.log(`Appel de ${callerId} vers ${targetId}`);
    
    const targetWs = connections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'incoming-call',
            callerId: callerId,
            callerName: callerName || callerId,
            offer: offer,
            timestamp: Date.now()
        }));
        console.log(`Notification envoyée à ${targetId}`);
        
        // Confirmer à l'appelant
        const callerWs = connections.get(callerId);
        if (callerWs) {
            callerWs.send(JSON.stringify({
                type: 'call-sent',
                targetId: targetId,
                message: 'Notification envoyée',
                timestamp: Date.now()
            }));
        }
    } else {
        console.log(`Cible ${targetId} non connectée`);
        const callerWs = connections.get(callerId);
        if (callerWs) {
            callerWs.send(JSON.stringify({
                type: 'user-offline',
                userId: targetId,
                message: 'L\'utilisateur n\'est pas connecté',
                timestamp: Date.now()
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
            answer: answer,
            timestamp: Date.now()
        }));
        
        // Créer une salle virtuelle
        const roomId = [callerId, answererId].sort().join('_');
        userRooms.set(callerId, roomId);
        userRooms.set(answererId, roomId);
        
        console.log(`Appel accepté entre ${callerId} et ${answererId}`);
    }
}

function handleIceCandidate(senderId, message) {
    const { targetId, candidate } = message;
    const targetWs = connections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'ice-candidate',
            senderId: senderId,
            candidate: candidate,
            timestamp: Date.now()
        }));
    }
}

function handleDeclineCall(declinerId, message) {
    const { callerId } = message;
    const callerWs = connections.get(callerId);
    
    if (callerWs && callerWs.readyState === WebSocket.OPEN) {
        callerWs.send(JSON.stringify({
            type: 'call-declined',
            declinerId: declinerId,
            timestamp: Date.now()
        }));
        console.log(`Appel refusé par ${declinerId}`);
    }
}

function handleEndCall(enderId, message) {
    const { targetId } = message;
    const targetWs = connections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'call-ended',
            enderId: enderId,
            timestamp: Date.now()
        }));
    }
    
    // Supprimer la salle
    userRooms.delete(enderId);
    userRooms.delete(targetId);
    console.log(`Appel terminé par ${enderId}`);
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
            isTyping: isTyping,
            timestamp: Date.now()
        }));
    }
}

function handleUpdateStatus(userId, message) {
    const { status } = message;
    console.log(`Mise à jour statut ${userId}: ${status}`);
    
    // Notifier les contacts
    notifyContacts(userId, {
        type: 'user-status',
        userId: userId,
        status: status,
        timestamp: Date.now()
    });
}

function handleGetUsers(userId) {
    const userWs = connections.get(userId);
    if (!userWs || userWs.readyState !== WebSocket.OPEN) return;
    
    const usersList = Array.from(connections.keys()).map(id => ({
        id: id,
        online: true,
        timestamp: Date.now()
    }));
    
    userWs.send(JSON.stringify({
        type: 'users-list',
        users: usersList,
        total: usersList.length,
        timestamp: Date.now()
    }));
}

// Diffuser le statut d'un utilisateur
function broadcastUserStatus(userId, status) {
    const message = JSON.stringify({
        type: 'user-status-change',
        userId: userId,
        status: status,
        timestamp: Date.now()
    });
    
    // Envoyer à tous les utilisateurs connectés
    connections.forEach((ws, id) => {
        if (id !== userId && ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}

// Notifier les contacts d'un utilisateur
function notifyContacts(userId, message) {
    const jsonMessage = JSON.stringify(message);
    
    // Pour l'instant, notifions tous les autres utilisateurs
    // Dans une vraie application, vous auriez une liste de contacts
    connections.forEach((ws, id) => {
        if (id !== userId && ws.readyState === WebSocket.OPEN) {
            ws.send(jsonMessage);
        }
    });
}

// Nettoyage périodique des connexions mortes
setInterval(() => {
    connections.forEach((ws, userId) => {
        if (ws.readyState !== WebSocket.OPEN) {
            console.log(`Nettoyage connexion morte: ${userId}`);
            connections.delete(userId);
            userRooms.delete(userId);
        }
    });
}, 60000); // Toutes les minutes

// Gestion de l'arrêt propre
process.on('SIGTERM', () => {
    console.log('SIGTERM reçu, arrêt gracieux...');
    
    // Informer tous les clients
    const shutdownMessage = JSON.stringify({
        type: 'server-shutdown',
        message: 'Le serveur va redémarrer',
        timestamp: Date.now()
    });
    
    connections.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(shutdownMessage);
            ws.close();
        }
    });
    
    // Fermer le serveur
    wss.close(() => {
        server.close(() => {
            console.log('Serveur arrêté proprement');
            process.exit(0);
        });
    });
});

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur WebSocket démarré sur le port ${PORT}`);
    console.log(`URL WebSocket: ws://localhost:${PORT}`);
    console.log(`URL HTTP: http://localhost:${PORT}/health`);
    console.log(`Connexions actives: ${connections.size}`);
});

// Exporter pour les tests
module.exports = { server, wss, connections };
