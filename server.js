require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const FLASK_SERVER = process.env.FLASK_SERVER || 'https://beabcd.pythonanywhere.com';
const JWT_SECRET = process.env.JWT_SECRET || 'your-strong-secret-key-here';
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Connected clients
const clients = new Map();

// Helper function to verify JWT tokens
const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.error('JWT verification error:', err.message);
    return null;
  }
};

// HTTP Routes

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    connections: clients.size,
    flaskServer: FLASK_SERVER
  });
});

// Proxy registration to Flask
app.post('/register', async (req, res) => {
  try {
    const response = await axios.post(`${FLASK_SERVER}/register`, req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500)
       .json(error.response?.data || { error: 'Registration failed' });
  }
});

// Proxy login to Flask
app.post('/login', async (req, res) => {
  try {
    const response = await axios.post(`${FLASK_SERVER}/login`, req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500)
       .json(error.response?.data || { error: 'Login failed' });
  }
});

// WebSocket Server
wss.on('connection', (ws, req) => {
  console.log('New client connected');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Authentication
      if (data.type === 'auth') {
        const { token } = data;
        
        // Verify JWT token
        const decoded = verifyToken(token);
        if (!decoded) {
          ws.send(JSON.stringify({
            type: 'auth_response',
            success: false,
            message: 'Invalid token'
          }));
          return ws.close();
        }

        // Verify with Flask server
        try {
          const response = await axios.post(`${FLASK_SERVER}/verify`, {
            token: token
          });

          if (response.data.valid) {
            clients.set(ws, {
              userId: decoded.user_id,
              username: decoded.username,
              authenticated: true
            });

            ws.send(JSON.stringify({
              type: 'auth_response',
              success: true,
              message: 'Authentication successful',
              user_id: decoded.user_id,
              username: decoded.username
            }));

            // Broadcast user joined
            broadcast({
              type: 'user_joined',
              userId: decoded.user_id,
              username: decoded.username,
              timestamp: new Date().toISOString()
            }, ws);
          } else {
            ws.send(JSON.stringify({
              type: 'auth_response',
              success: false,
              message: 'Invalid credentials'
            }));
          }
        } catch (error) {
          console.error('Flask verification error:', error.message);
          ws.send(JSON.stringify({
            type: 'auth_response',
            success: false,
            message: 'Authentication service unavailable'
          }));
        }
      }
      // Handle chat messages
      else if (data.type === 'message') {
        const client = clients.get(ws);
        if (client?.authenticated) {
          const messageData = {
            type: 'message',
            userId: client.userId,
            username: client.username,
            content: data.content,
            timestamp: new Date().toISOString()
          };
          
          // Store message in Flask (optional)
          try {
            await axios.post(`${FLASK_SERVER}/store_message`, messageData, {
              headers: { Authorization: `Bearer ${data.token}` }
            });
          } catch (error) {
            console.error('Failed to store message:', error.message);
          }
          
          broadcast(messageData);
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Not authenticated'
          }));
        }
      }
    } catch (error) {
      console.error('Message processing error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      broadcast({
        type: 'user_left',
        userId: client.userId,
        username: client.username,
        timestamp: new Date().toISOString()
      });
      clients.delete(ws);
    }
    console.log('Client disconnected');
  });
});

// Broadcast to all connected clients
function broadcast(message, exclude = null) {
  const messageStr = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Flask server: ${FLASK_SERVER}`);
});
