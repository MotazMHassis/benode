// server.js
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const users = new Map(); // username -> WebSocket

// REST endpoint to get all users
app.get('/users', (req, res) => {
  res.json(Array.from(users.keys()));
});

// WebSocket connection
wss.on('connection', (ws, req) => {
  const username = new URL(req.url, `https://${req.headers.host}`).searchParams.get('username');
  
  if (!username) {
    ws.close();
    return;
  }

  // Add user to the map
  users.set(username, ws);
  broadcastUserList();

  // Handle messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'message' && data.receiver && data.content) {
        const receiverWs = users.get(data.receiver);
        if (receiverWs) {
          receiverWs.send(JSON.stringify({
            type: 'message',
            sender: username,
            receiver: data.receiver,
            content: data.content
          }));
        }
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    users.delete(username);
    broadcastUserList();
  });
});

function broadcastUserList() {
  const userList = Array.from(users.keys());
  const message = JSON.stringify({
    type: 'user_update',
    users: userList
  });

  users.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
