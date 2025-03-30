require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(cookieParser());
app.use(express.json());

const FLASK_SERVER = process.env.FLASK_SERVER || 'https://beabcd.pythonanywhere.com';
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });

const clients = new Map();

// HTTP endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'OK', connections: clients.size });
});

// WebSocket connection
wss.on('connection', (ws, req) => {
  console.log('New connection');
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'auth') {
        const { user_id, username } = data;
        
        try {
          const response = await axios.post(`${FLASK_SERVER}/verify`, {}, {
            headers: { Cookie: req.headers.cookie }
          });
          
          if (response.data.valid && response.data.user_id == user_id) {
            clients.set(ws, { 
              userId: user_id,
              username: username,
              authenticated: true
            });
            
            ws.send(JSON.stringify({
              type: 'auth_response',
              success: true,
              user_id,
              username
            }));
          } else {
            throw new Error('Invalid session');
          }
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'auth_response',
            success: false,
            message: 'Authentication failed'
          }));
          ws.close();
        }
      }
      
      else if (data.type === 'message') {
        const client = clients.get(ws);
        if (client?.authenticated) {
          broadcast({
            type: 'message',
            userId: client.userId,
            username: client.username,
            content: data.content,
            timestamp: new Date().toISOString()
          }, ws);
        }
      }
    } catch (err) {
      console.error('WS error:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcast(data, exclude = null) {
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
