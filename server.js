const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
app.use(express.json());

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
                        authenticated: true,
                        device_id: data.device_id || null
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
                    const messageData = {
                        type: 'message',
                        username: client.username,
                        content: data.content,
                        timestamp: new Date().toISOString()
                    };
                    
                    broadcast(messageData);
                    
                    // Send push notification to all users (including offline ones)
                    try {
                        await axios.post(`${FLASK_SERVER}/notify-all`, {
                            sender: client.username,
                            message: data.content
                        });
                        console.log('Notification sent to server');
                    } catch (error) {
                        console.error('Error sending notification:', error.message);
                    }
                } else {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Not authenticated'
                    }));
                }
            }
            // Handle device ID update
            else if (data.type === 'update_device') {
                const client = clients.get(ws);
                if (client && client.authenticated) {
                    // Update device ID in Flask server
                    try {
                        await axios.post(`${FLASK_SERVER}/update-device`, {
                            user_id: client.user_id,
                            device_id: data.device_id
                        });
                        
                        // Update local client info
                        client.device_id = data.device_id;
                        clients.set(ws, client);
                        
                        ws.send(JSON.stringify({
                            type: 'device_update_response',
                            success: true,
                            message: 'Device ID updated successfully'
                        }));
                    } catch (error) {
                        ws.send(JSON.stringify({
                            type: 'device_update_response',
                            success: false,
                            message: 'Failed to update device ID'
                        }));
                    }
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

// Endpoint to send a direct message to a specific user
app.post('/send-direct', async (req, res) => {
    const { username, message, sender } = req.body;
    
    if (!username || !message || !sender) {
        return res.status(400).json({ 
            success: false, 
            message: 'Missing username, message, or sender' 
        });
    }
    
    let delivered = false;
    
    // Try to deliver to connected client
    for (const [ws, client] of clients.entries()) {
        if (client.username === username && client.authenticated) {
            ws.send(JSON.stringify({
                type: 'direct_message',
                sender: sender,
                content: message,
                timestamp: new Date().toISOString()
            }));
            delivered = true;
            break;
        }
    }
    
    // If not delivered via WebSocket, send via Flask notification system
    if (!delivered) {
        try {
            await axios.post(`${FLASK_SERVER}/notify-all`, {
                sender: sender,
                message: message,
                target_username: username
            });
            delivered = true;
        } catch (error) {
            console.error('Error sending notification:', error.message);
        }
    }
    
    return res.json({
        success: true,
        delivered: delivered,
        message: delivered ? 'Message delivered' : 'Message queued for delivery'
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
