const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active connections and offline messages
const activeConnections = new Map();
const offlineMessages = new Map();
const MESSAGE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// Middleware for JSON parsing
app.use(express.json());

// REST endpoint to get all users
app.get('/users', (req, res) => {
  res.json(Array.from(activeConnections.keys()));
});

// Endpoint to check if user is online
app.get('/user/:username/status', (req, res) => {
  const isOnline = activeConnections.has(req.params.username);
  res.json({ online: isOnline });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const username = new URL(req.url, `https://${req.headers.host}`).searchParams.get('username');
  
  if (!username) {
    ws.close(4001, 'Username required');
    return;
  }

  // Close any existing connection for this user
  if (activeConnections.has(username)) {
    activeConnections.get(username).close(4002, 'Duplicate connection');
  }

  // Add new connection
  activeConnections.set(username, ws);
  broadcastUserList();

  // Send queued messages if any
  if (offlineMessages.has(username)) {
    const messages = offlineMessages.get(username).filter(msg => 
      Date.now() - msg.timestamp < MESSAGE_EXPIRY
    );
    
    messages.forEach(msg => {
      ws.send(JSON.stringify(msg));
    });

    // Remove delivered messages
    offlineMessages.set(username, 
      offlineMessages.get(username).filter(msg => 
        Date.now() - msg.timestamp >= MESSAGE_EXPIRY
      )
    );
    
    if (offlineMessages.get(username).length === 0) {
      offlineMessages.delete(username);
    }
  }

  // Message handler
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle ping messages
      if (data.type === 'ping') {
        return;
      }
      
      // Handle regular messages
      if (data.type === 'message' && data.receiver && data.content) {
        const messageData = {
          type: 'message',
          sender: username,
          receiver: data.receiver,
          content: data.content,
          timestamp: Date.now()
        };

        // Check if recipient is online
        if (activeConnections.has(data.receiver)) {
          activeConnections.get(data.receiver).send(JSON.stringify(messageData));
        } else {
          // Store for offline user
          if (!offlineMessages.has(data.receiver)) {
            offlineMessages.set(data.receiver, []);
          }
          offlineMessages.get(data.receiver).push(messageData);
        }
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  // Connection closed handler
  ws.on('close', () => {
    if (activeConnections.get(username) === ws) {
      activeConnections.delete(username);
      broadcastUserList();
    }
  });

  // Error handler
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    if (activeConnections.get(username) === ws) {
      activeConnections.delete(username);
      broadcastUserList();
    }
  });
});

// Broadcast updated user list to all clients
function broadcastUserList() {
  const userList = Array.from(activeConnections.keys());
  const message = JSON.stringify({
    type: 'user_update',
    users: userList
  });

  activeConnections.forEach((ws, username) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
      } catch (err) {
        console.error('Error broadcasting to user', username, err);
      }
    }
  });
}

// Cleanup expired messages periodically
setInterval(() => {
  const now = Date.now();
  offlineMessages.forEach((messages, username) => {
    const validMessages = messages.filter(msg => now - msg.timestamp < MESSAGE_EXPIRY);
    if (validMessages.length > 0) {
      offlineMessages.set(username, validMessages);
    } else {
      offlineMessages.delete(username);
    }
  });
}, 60 * 60 * 1000); // Run hourly

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
