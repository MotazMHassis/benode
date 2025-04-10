const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const users = new Map(); // username -> WebSocket

console.log('Server initialization started');

// REST endpoint to get all users
app.get('/users', (req, res) => {
  console.log(`GET /users request received - current users: ${Array.from(users.keys())}`);
  res.json(Array.from(users.keys()));
});

// WebSocket connection
wss.on('connection', (ws, req) => {
  console.log(`New WebSocket connection attempt from: ${req.headers.host}`);
  
  const username = new URL(req.url, `https://${req.headers.host}`).searchParams.get('username');
  
  if (!username) {
    console.log('Connection rejected: Missing username parameter');
    ws.close();
    return;
  }
  
  console.log(`User connected: ${username}`);
  
  // Add user to the map
  users.set(username, ws);
  console.log(`Current user count: ${users.size}`);
  broadcastUserList();
  
  // Handle messages
  ws.on('message', (message) => {
    console.log(`Message received from ${username}: ${message}`);
    
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'message' && data.receiver && data.content) {
        console.log(`Message from ${username} to ${data.receiver}: ${data.content}`);
        
        const receiverWs = users.get(data.receiver);
        if (receiverWs) {
          console.log(`Forwarding message to ${data.receiver}`);
          receiverWs.send(JSON.stringify({
            type: 'message',
            sender: username,
            receiver: data.receiver,
            content: data.content
          }));
        } else {
          console.log(`Failed to forward message: Receiver ${data.receiver} not found`);
        }
      } else {
        console.log(`Invalid message format from ${username}:`, data);
      }
    } catch (err) {
      console.error(`Error processing message from ${username}:`, err);
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    console.log(`User disconnected: ${username}`);
    users.delete(username);
    console.log(`Current user count: ${users.size}`);
    broadcastUserList();
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for user ${username}:`, error);
  });
});

function broadcastUserList() {
  const userList = Array.from(users.keys());
  console.log(`Broadcasting updated user list: ${userList.join(', ')}`);
  
  const message = JSON.stringify({
    type: 'user_update',
    users: userList
  });
  
  let successCount = 0;
  users.forEach((ws, username) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      successCount++;
    } else {
      console.log(`Skipping broadcast to ${username}: WebSocket not open (state: ${ws.readyState})`);
    }
  });
  
  console.log(`User list broadcast complete: ${successCount}/${users.size} active connections received the update`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started and running on port ${PORT}`);
  console.log(`WebSocket server available at ws://localhost:${PORT}`);
  console.log(`REST endpoint available at http://localhost:${PORT}/users`);
});
