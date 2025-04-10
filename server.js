const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// Server configuration
const PORT = process.env.PORT || 3000;
const MESSAGE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const PING_INTERVAL = 60 * 1000; // 1 minute
const CONNECTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

console.log('[SERVER] Initializing server with configuration:');
console.log(`[SERVER] PORT: ${PORT}`);
console.log(`[SERVER] MESSAGE_EXPIRY: ${MESSAGE_EXPIRY / (60 * 60 * 1000)} hours`);
console.log(`[SERVER] PING_INTERVAL: ${PING_INTERVAL / 1000} seconds`);
console.log(`[SERVER] CONNECTION_TIMEOUT: ${CONNECTION_TIMEOUT / (60 * 1000)} minutes`);

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

console.log('[SERVER] Server initialized');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
console.log(`[SERVER] Static files served from: ${path.join(__dirname, 'public')}`);

// REST Endpoints
app.get('/api/users', (req, res) => {
  const onlineUsers = Array.from(activeConnections.keys());
  const offlineUsers = Array.from(userStatus.keys())
    .filter(user => !activeConnections.has(user));
  
  console.log(`[API] GET /api/users - Online: ${onlineUsers.length}, Offline: ${offlineUsers.length}`);
  
  res.json({
    online: onlineUsers,
    offline: offlineUsers
  });
});

app.get('/api/user/:username/status', (req, res) => {
  const username = req.params.username;
  const isOnline = activeConnections.has(username);
  const lastSeen = userStatus.get(username)?.lastSeen || null;
  
  console.log(`[API] GET /api/user/${username}/status - Online: ${isOnline}, LastSeen: ${lastSeen ? new Date(lastSeen).toISOString() : 'never'}`);
  
  res.json({ online: isOnline, lastSeen });
});

// WebSocket Server
wss.on('connection', (ws, req) => {
  // Extract username from URL
  const username = new URL(req.url, `http://${req.headers.host}`)
    .searchParams.get('username');
  
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] New connection attempt from ${clientIP} with username: ${username || 'NONE'}`);
  
  // Validate username
  if (!username) {
    console.error(`[ERROR] Connection rejected: No username provided from ${clientIP}`);
    ws.close(4001, 'Username required');
    return;
  }

  // Handle duplicate connections
  if (activeConnections.has(username)) {
    console.log(`[WS] Duplicate connection for user ${username} from ${clientIP}`);
    activeConnections.get(username).close(4002, 'Duplicate connection');
  }

  // Store new connection
  activeConnections.set(username, ws);
  userStatus.set(username, { 
    lastSeen: null,
    status: 'online'
  });
  
  console.log(`[WS] User ${username} connected from ${clientIP}`);
  console.log(`[USERS] Active connections: ${activeConnections.size}`);
  
  // Broadcast updated user list
  broadcastUserList();

  // Deliver any queued messages
  const queuedMessages = offlineMessages.get(username)?.length || 0;
  if (queuedMessages > 0) {
    console.log(`[MSG] Delivering ${queuedMessages} queued messages to ${username}`);
  }
  deliverQueuedMessages(username, ws);

  // Setup message handler
  ws.on('message', (message) => handleMessage(username, message));

  // Setup connection timeout
  setupConnectionTimeout(username, ws);

  // Handle connection close
  ws.on('close', (code, reason) => {
    console.log(`[WS] Connection closed for ${username}: Code ${code}, Reason: ${reason || 'No reason provided'}`);
    handleDisconnect(username);
  });

  // Handle errors
  ws.on('error', (error) => handleError(username, error));
});

// Helper Functions
function deliverQueuedMessages(username, ws) {
  if (!offlineMessages.has(username)) return;

  const now = Date.now();
  const messages = offlineMessages.get(username)
    .filter(msg => now - msg.timestamp < MESSAGE_EXPIRY);

  console.log(`[MSG] Delivering ${messages.length} queued messages to ${username}`);
  
  let deliveredCount = 0;
  messages.forEach(msg => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      deliveredCount++;
    }
  });

  console.log(`[MSG] Successfully delivered ${deliveredCount}/${messages.length} messages to ${username}`);

  // Update offline messages store
  const remainingMessages = offlineMessages.get(username)
    .filter(msg => now - msg.timestamp >= MESSAGE_EXPIRY);
  
  if (remainingMessages.length > 0) {
    console.log(`[MSG] ${remainingMessages.length} expired messages removed for ${username}`);
    offlineMessages.set(username, remainingMessages);
  } else {
    console.log(`[MSG] All messages delivered or expired for ${username}, clearing queue`);
    offlineMessages.delete(username);
  }
}

function handleMessage(sender, message) {
  try {
    const data = JSON.parse(message);
    console.log(`[MSG] Received message from ${sender}: ${data.type}`);
    
    switch (data.type) {
      case 'ping':
        handlePing(sender);
        break;
      case 'message':
        handleChatMessage(sender, data);
        break;
      default:
        console.log(`[MSG] Unknown message type from ${sender}: ${data.type}`);
    }
  } catch (err) {
    console.error(`[ERROR] Message parsing error from ${sender}: ${err.message}`);
    console.error(`[ERROR] Raw message: ${message.toString().substring(0, 100)}${message.toString().length > 100 ? '...' : ''}`);
  }
}

function handlePing(username) {
  const ws = activeConnections.get(username);
  if (ws?.readyState === WebSocket.OPEN) {
    console.log(`[MSG] Responding to ping from ${username}`);
    ws.send(JSON.stringify({ 
      type: 'pong', 
      timestamp: Date.now() 
    }));
  } else {
    console.log(`[MSG] Cannot respond to ping from ${username}: Connection not open`);
  }
}

function handleChatMessage(sender, data) {
  if (!data.receiver || !data.content) {
    console.error(`[ERROR] Invalid message format from ${sender}: Missing receiver or content`);
    return;
  }

  const message = {
    type: 'message',
    sender,
    receiver: data.receiver,
    content: data.content,
    timestamp: Date.now()
  };

  console.log(`[MSG] Chat message: ${sender} -> ${data.receiver} (${data.content.length} chars)`);

  // Try to deliver immediately
  const receiverWs = activeConnections.get(data.receiver);
  if (receiverWs?.readyState === WebSocket.OPEN) {
    console.log(`[MSG] Delivering message immediately to ${data.receiver}`);
    receiverWs.send(JSON.stringify(message));
    return;
  }

  // Store for offline delivery
  console.log(`[MSG] ${data.receiver} is offline, queueing message`);
  if (!offlineMessages.has(data.receiver)) {
    console.log(`[MSG] Creating new message queue for ${data.receiver}`);
    offlineMessages.set(data.receiver, []);
  }
  offlineMessages.get(data.receiver).push(message);
  console.log(`[MSG] Message queued, ${data.receiver} now has ${offlineMessages.get(data.receiver).length} pending messages`);
}

function handleDisconnect(username) {
  if (activeConnections.has(username)) {
    activeConnections.delete(username);
    userStatus.set(username, { 
      lastSeen: Date.now(),
      status: 'offline'
    });
    
    console.log(`[WS] User ${username} disconnected`);
    console.log(`[USERS] Active connections: ${activeConnections.size}`);
    
    broadcastUserList();
  }
}

function handleError(username, error) {
  console.error(`[ERROR] Connection error for ${username}: ${error.message}`);
  console.error(`[ERROR] Stack: ${error.stack}`);
  handleDisconnect(username);
}

function setupConnectionTimeout(username, ws) {
  ws.isAlive = true;
  
  ws.on('pong', () => {
    console.log(`[WS] Received pong from ${username}`);
    ws.isAlive = true;
  });

  const interval = setInterval(() => {
    if (!ws.isAlive) {
      console.log(`[WS] Connection timeout for ${username}, terminating`);
      ws.terminate();
      clearInterval(interval);
      return;
    }
    ws.isAlive = false;
    console.log(`[WS] Sending ping to ${username}`);
    ws.ping();
  }, CONNECTION_TIMEOUT / 2);
  
  console.log(`[WS] Connection timeout monitor setup for ${username}: ${CONNECTION_TIMEOUT / 2}ms interval`);
}

function broadcastUserList() {
  const userList = Array.from(activeConnections.keys());
  console.log(`[USERS] Broadcasting user list update: ${userList.length} online users`);
  
  const message = JSON.stringify({
    type: 'user_update',
    users: userList,
    timestamp: Date.now()
  });

  let successCount = 0;
  activeConnections.forEach((ws, user) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      successCount++;
    } else {
      console.log(`[USERS] Cannot send user list to ${user}: Connection not open (state: ${ws.readyState})`);
    }
  });
  
  console.log(`[USERS] User list broadcast completed: ${successCount}/${activeConnections.size} clients received update`);
}

// Cleanup Tasks
setInterval(() => {
  const now = Date.now();
  console.log('[SERVER] Running periodic cleanup tasks...');
  
  // Clean expired messages
  let totalExpiredMessages = 0;
  let clearedQueues = 0;
  
  offlineMessages.forEach((messages, user) => {
    const initialCount = messages.length;
    const validMessages = messages.filter(
      msg => now - msg.timestamp < MESSAGE_EXPIRY
    );
    
    const expiredCount = initialCount - validMessages.length;
    totalExpiredMessages += expiredCount;
    
    if (expiredCount > 0) {
      console.log(`[MSG] Removed ${expiredCount} expired messages for ${user}`);
    }
    
    if (validMessages.length > 0) {
      offlineMessages.set(user, validMessages);
    } else {
      offlineMessages.delete(user);
      clearedQueues++;
    }
  });
  
  console.log(`[SERVER] Message cleanup: Removed ${totalExpiredMessages} expired messages, cleared ${clearedQueues} empty queues`);

  // Clean old user status
  let removedUsers = 0;
  userStatus.forEach((status, user) => {
    if (status.lastSeen && now - status.lastSeen > MESSAGE_EXPIRY) {
      userStatus.delete(user);
      removedUsers++;
    }
  });
  
  console.log(`[SERVER] User cleanup: Removed ${removedUsers} inactive users`);
  console.log(`[SERVER] Current state: ${activeConnections.size} active connections, ${offlineMessages.size} message queues, ${userStatus.size} user statuses`);
}, MESSAGE_EXPIRY / 24); // Run hourly

// Global ping interval
setInterval(() => {
  console.log(`[WS] Sending global ping to ${wss.clients.size} clients`);
  
  let pingCount = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.ping();
      pingCount++;
    }
  });
  
  console.log(`[WS] Global ping sent to ${pingCount} clients`);
}, PING_INTERVAL);

// Start server
server.listen(PORT, () => {
  console.log(`[SERVER] Server started successfully`);
  console.log(`[SERVER] HTTP server running on http://localhost:${PORT}`);
  console.log(`[SERVER] WebSocket server available at ws://localhost:${PORT}`);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('[SERVER] Received SIGINT, shutting down server...');
  
  // Close all WebSocket connections
  wss.clients.forEach(client => {
    client.close(1001, 'Server shutting down');
  });
  
  // Close HTTP server
  server.close(() => {
    console.log('[SERVER] HTTP server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught exception:');
  console.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled promise rejection:');
  console.error(reason);
});
