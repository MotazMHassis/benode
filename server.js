const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Flask server URL
const FLASK_SERVER = 'https://beabcd.pythonanywhere.com';

// Connected clients with their user info
const clients = new Map();

// WebSocket server
wss.on('connection', (ws) => {
    console.log('Client connected');
    
    // Handle messages from clients
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // Handle authentication
            if (data.type === 'auth') {
                // Verify with Flask server
                const response = await axios.post(`${FLASK_SERVER}/verify`, {
                    username: data.username,
                    user_id: data.user_id
                });
                
                if (response.data.valid) {
                    // Store user info with this connection
                    clients.set(ws, {
                        username: data.username,
                        user_id: data.user_id,
                        authenticated: true
                    });
                    
                    ws.send(JSON.stringify({
                        type: 'auth_response',
                        success: true,
                        message: 'Authentication successful'
                    }));
                    
                    // Broadcast user joined to all clients
                    broadcast({
                        type: 'user_joined',
                        username: data.username
                    }, ws);
                } else {
                    ws.send(JSON.stringify({
                        type: 'auth_response',
                        success: false,
                        message: 'Invalid credentials'
                    }));
                }
            }
            // Handle chat message
            else if (data.type === 'message') {
                const client = clients.get(ws);
                if (client && client.authenticated) {
                    // Broadcast the message to all clients
                    broadcast({
                        type: 'message',
                        username: client.username,
                        content: data.content,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Not authenticated'
                    }));
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });
    
    // Handle client disconnect
    ws.on('close', () => {
        const client = clients.get(ws);
        if (client) {
            // Broadcast user left
            broadcast({
                type: 'user_left',
                username: client.username
            });
            
            // Remove client from map
            clients.delete(ws);
        }
        console.log('Client disconnected');
    });
});

// Function to broadcast to all connected clients
function broadcast(message, exclude = null) {
    const messageStr = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

// Simple health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', connections: clients.size });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
