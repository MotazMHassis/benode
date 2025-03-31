// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(bodyParser.json());

// Store connected clients
const connectedClients = new Map();

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  socket.on('register', (deviceToken) => {
    console.log('Device registered:', deviceToken);
    connectedClients.set(deviceToken, socket.id);
    
    // Send acknowledgment back to the client
    socket.emit('registration_success', { message: 'Successfully registered for notifications' });
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Remove the disconnected client from our map
    for (const [deviceToken, socketId] of connectedClients.entries()) {
      if (socketId === socket.id) {
        connectedClients.delete(deviceToken);
        break;
      }
    }
  });
});

// Endpoint to send notification to all connected clients
app.post('/broadcast', (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Broadcast to all connected clients
    io.emit('notification', { 
      message,
      timestamp: new Date().toISOString()
    });
    
    console.log('Notification broadcasted:', message);
    res.status(200).json({ success: true, message: 'Notification sent successfully' });
  } catch (error) {
    console.error('Error broadcasting notification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to check server status
app.get('/status', (req, res) => {
  res.status(200).json({ 
    status: 'online',
    connectedClients: connectedClients.size
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Node.js server running on port ${PORT}`);
});
