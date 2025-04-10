const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// Server configuration
const PORT = process.env.PORT || 3000;
const MESSAGE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const PING_INTERVAL = 60 * 1000; // 1 minute
const CONNECTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Initialize server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  clientTracking: true // Track all connected clients
});

// Data stores
const activeConnections = new Map(); // username -> WebSocket
const offlineMessages = new Map(); // username -> [messages]
const userStatus = new Map(); // username -> { lastSeen, status }

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// REST Endpoints
app.get('/api/users', (req, res) => {
  res.json({
    online: Array.from(activeConnections.keys()),
    offline: Array.from(userStatus.keys())
      .filter(user => !activeConnections.has(user))
  });
});

app.get('/api/user/:username/status', (req, res) => {
  const isOnline = activeConnections.has(req.params.username);
  const lastSeen = userStatus.get(req.params.username)?.lastSeen || null;
  res.json({ online: isOnline, lastSeen });
});

// WebSocket Server
wss.on('connection', (ws, req) => {
  // Extract username from URL
  const username = new URL(req.url, `http://${req.headers.host}`)
    .searchParams.get('username');
  
  // Validate username
  if (!username) {
    ws.close(4001, 'Username required');
    return;
  }

  // Handle duplicate connections
  if (activeConnections.has(username)) {
    activeConnections.get(username).close(4002, 'Duplicate connection');
  }

  // Store new connection
  activeConnections.set(username, ws);
  userStatus.set(username, { 
    lastSeen: null,
    status: 'online'
  });
  
  // Broadcast updated user list
  broadcastUserList();

  // Deliver any queued messages
  deliverQueuedMessages(username, ws);

  // Setup message handler
  ws.on('message', (message) => handleMessage(username, message));

  // Setup connection timeout
  setupConnectionTimeout(username, ws);

  // Handle connection close
  ws.on('close', () => handleDisconnect(username));

  // Handle errors
  ws.on('error', (error) => handleError(username, error));
});

// Helper Functions
function deliverQueuedMessages(username, ws) {
  if (!offlineMessages.has(username)) return;

  const now = Date.now();
  const messages = offlineMessages.get(username)
    .filter(msg => now - msg.timestamp < MESSAGE_EXPIRY);

  messages.forEach(msg => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });

  // Update offline messages store
  const remainingMessages = offlineMessages.get(username)
    .filter(msg => now - msg.timestamp >= MESSAGE_EXPIRY);
  
  if (remainingMessages.length > 0) {
    offlineMessages.set(username, remainingMessages);
  } else {
    offlineMessages.delete(username);
  }
}

function handleMessage(sender, message) {
  try {
    const data = JSON.parse(message);
    
    switch (data.type) {
      case 'ping':
        handlePing(sender);
        break;
      case 'message':
        handleChatMessage(sender, data);
        break;
      default:
        console.log('Unknown message type:', data.type);
    }
  } catch (err) {
    console.error('Message processing error:', err);
  }
}

function handlePing(username) {
  const ws = activeConnections.get(username);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ 
      type: 'pong', 
      timestamp: Date.now() 
    }));
  }
}

function handleChatMessage(sender, data) {
  if (!data.receiver || !data.content) {
    console.log('Invalid message format from', sender);
    return;
  }

  const message = {
    type: 'message',
    sender,
    receiver: data.receiver,
    content: data.content,
    timestamp: Date.now()
  };

  // Try to deliver immediately
  const receiverWs = activeConnections.get(data.receiver);
  if (receiverWs?.readyState === WebSocket.OPEN) {
    receiverWs.send(JSON.stringify(message));
    return;
  }

  // Store for offline delivery
  if (!offlineMessages.has(data.receiver)) {
    offlineMessages.set(data.receiver, []);
  }
  offlineMessages.get(data.receiver).push(message);
}

function handleDisconnect(username) {
  if (activeConnections.get(username)) {
    activeConnections.delete(username);
    userStatus.set(username, { 
      lastSeen: Date.now(),
      status: 'offline'
    });
    broadcastUserList();
  }
}

function handleError(username, error) {
  console.error(`Connection error for ${username}:`, error);
  handleDisconnect(username);
}

function setupConnectionTimeout(username, ws) {
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const interval = setInterval(() => {
    if (!ws.isAlive) {
      ws.terminate();
      clearInterval(interval);
      return;
    }
    ws.isAlive = false;
    ws.ping();
  }, CONNECTION_TIMEOUT / 2);
}

function broadcastUserList() {
  const userList = Array.from(activeConnections.keys());
  const message = JSON.stringify({
    type: 'user_update',
    users: userList,
    timestamp: Date.now()
  });

  activeConnections.forEach((ws, user) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// Cleanup Tasks
setInterval(() => {
  const now = Date.now();
  
  // Clean expired messages
  offlineMessages.forEach((messages, user) => {
    const validMessages = messages.filter(
      msg => now - msg.timestamp < MESSAGE_EXPIRY
    );
    
    if (validMessages.length > 0) {
      offlineMessages.set(user, validMessages);
    } else {
      offlineMessages.delete(user);
    }
  });

  // Clean old user status
  userStatus.forEach((status, user) => {
    if (status.lastSeen && now - status.lastSeen > MESSAGE_EXPIRY) {
      userStatus.delete(user);
    }
  });
}, MESSAGE_EXPIRY / 24); // Run hourly

// Global ping interval
setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.ping();
    }
  });
}, PING_INTERVAL);

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server available at ws://localhost:${PORT}`);
});
