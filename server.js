require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const http = require('http');

const app = express();

// Middlewareee
app.use(cors());
app.use(express.json());

// Configuration
const FLASK_SERVER = process.env.FLASK_SERVER || 'https://beabcd.pythonanywhere.com';
const JWT_SECRET = process.env.JWT_SECRET || 'your-strong-secret-key-here';

// Create HTTP server (HTTPS is handled by your hosting provider)
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Connected clients
const clients = new Map();

// Helper function to verify tokens
const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
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

// User registration (proxied to Flask)
app.post('/register', async (req, res) => {
  try {
    const response = await axios.post(`${FLASK_SERVER}/register`, req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500)
       .json(error.response?.data || { error: 'Registration failed' });
  }
});

// User login (proxied to Flask)
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Verify with Flask server
    const response = await axios.post(`${FLASK_SERVER}/login`, {
      username,
      password
    });

    if (response.data.success) {
      // Create JWT token
      const token = jwt.sign(
        { 
          userId: response.data.user_id, 
          username: response.data.username 
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({
        success: true,
        user_id: response.data.user_id,
        username: response.data.username,
        token
      });
    } else {
      res.status(401).json(response.data);
    }
  } catch (error) {
    res.status(error.response?.status || 500)
       .json(error.response?.data || { error: 'Login failed' });
  }
});

// WebSocket Server
wss.on('connection', (ws, req) => {
  console.log('New client connected');

  // Extract IP for logging (useful for rate limiting)
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`Connection from IP: ${ip}`);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Authentication
      if (data.type === 'auth') {
        const { token, user_id, username } = data;
        
        // Verify JWT token
        const decoded = verifyToken(token);
        if (!decoded || decoded.userId !== user_id) {
          ws.send(JSON.stringify({
            type: 'auth_response',
            success: false,
            message: 'Invalid token'
          }));
          return ws.close();
        }

        // Verify with Flask server
        try {
          const response = await axios.post(`${FLASK_SERVER}/verify_user`, {
            user_id,
            username
          }, {
            headers: { Authorization: `Bearer ${token}` }
          });

          if (response.data.valid) {
            clients.set(ws, {
              userId: user_id,
              username,
              authenticated: true,
              ip
            });

            ws.send(JSON.stringify({
              type: 'auth_response',
              success: true,
              message: 'Authentication successful'
            }));

            // Broadcast user joined
            broadcast({
              type: 'user_joined',
              userId,
              username,
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
      // Chat messages
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Flask server: ${FLASK_SERVER}`);
});
