import { io, Socket } from 'socket.io-client';
import { API_URL } from '../config/constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

class SocketService {
  private socket: Socket | null = null;
  private isConnecting: boolean = false;
  private connectionPromise: Promise<Socket | null> | null = null;
  private onlineUsers: Set<string> = new Set();
  private receivedMessages: Set<string> = new Set();
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  // Get socket instance (creates one if doesn't exist)
  async initSocket(): Promise<Socket | null> {
    // If already connected, return existing socket
    if (this.socket?.connected) {
      return this.socket;
    }

    // If already connecting, return the existing promise
    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    // Create a new connection promise
    this.isConnecting = true;
    this.connectionPromise = this.createConnection();
    return this.connectionPromise;
  }

  private async createConnection(): Promise<Socket | null> {
    try {
      const token = await AsyncStorage.getItem('token');
      
      if (!token) {
        console.log('No token available for socket connection');
        this.isConnecting = false;
        return null;
      }

      // Close existing socket if it exists
      if (this.socket) {
        this.socket.close();
      }

      // Create new socket connection
      this.socket = io(API_URL, {
        auth: {
          token
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        timeout: 10000
      });

      // Set up event handlers
      this.socket.on('connect', () => {
        console.log('Socket connected with ID:', this.socket?.id);
        this.reconnectAttempts = 0;
      });

      this.socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
      });

      this.socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        this.reconnectAttempts++;
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.log('Max reconnection attempts reached, giving up');
          this.socket?.close();
        }
      });

      this.socket.on('onlineUsers', (users: string[]) => {
        this.onlineUsers = new Set(users);
      });

      // Wait for connection to establish
      await new Promise<void>((resolve, reject) => {
        if (!this.socket) return reject('Socket initialization failed');
        
        // Set timeout for connection
        const timeout = setTimeout(() => {
          reject('Socket connection timeout');
        }, 5000);

        this.socket.on('connect', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.socket.on('connect_error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.isConnecting = false;
      return this.socket;
    } catch (error) {
      console.error('Socket connection failed:', error);
      this.isConnecting = false;
      return null;
    }
  }

  // Join a chat room
  joinChatRoom(roomId: string): void {
    if (this.socket?.connected) {
      this.socket.emit('joinRoom', { roomId });
      console.log('Joined room:', roomId);
    } else {
      console.error('Cannot join room: socket not connected');
      // Try to reconnect and then join
      this.initSocket().then(socket => {
        if (socket) {
          socket.emit('joinRoom', { roomId });
          console.log('Joined room after reconnection:', roomId);
        }
      });
    }
  }

  // Send a message
  sendMessage(messageData: any): boolean {
    if (!this.socket?.connected) {
      console.error('Cannot send message: socket not connected');
      return false;
    }

    this.socket.emit('sendMessage', messageData);
    console.log('Message sent via socket:', messageData.tempId);
    return true;
  }

  // Send a group message
  sendGroupMessage(messageData: any): boolean {
    if (!this.socket?.connected) {
      console.error('Cannot send group message: socket not connected');
      return false;
    }

    this.socket.emit('sendGroupMessage', messageData);
    console.log('Group message sent via socket:', messageData.tempId);
    return true;
  }

  // Track received messages to prevent duplicates
  markMessageReceived(messageId: string, tempId?: string): void {
    this.receivedMessages.add(messageId);
    if (tempId) this.receivedMessages.add(tempId);
    
    // Periodically clean up the message cache to avoid memory leaks
    if (this.receivedMessages.size > 500) {
      this.clearMessageCache();
    }
  }

  isMessageReceived(messageId: string, tempId?: string): boolean {
    return this.receivedMessages.has(messageId) || 
           (tempId ? this.receivedMessages.has(tempId) : false);
  }

  // Clear message cache periodically (keep last 200 messages)
  clearMessageCache(): void {
    if (this.receivedMessages.size > 200) {
      const messagesToKeep = Array.from(this.receivedMessages).slice(-200);
      this.receivedMessages = new Set(messagesToKeep);
    }
  }

  // User typing status
  sendTypingStatus(data: { sender: string, receiver: string }): void {
    if (this.socket?.connected) {
      this.socket.emit('typing', data);
    }
  }

  sendStopTypingStatus(data: { sender: string, receiver: string }): void {
    if (this.socket?.connected) {
      this.socket.emit('stopTyping', data);
    }
  }

  // Message read status
  markMessageAsRead(data: { messageId: string, sender: string, receiver: string }): void {
    if (this.socket?.connected) {
      this.socket.emit('messageRead', data);
    }
  }

  // Reactions
  addReaction(data: { messageId: string, userId: string, emoji: string }): void {
    if (this.socket?.connected) {
      this.socket.emit('addReaction', data);
    }
  }

  // Unsend message
  unsendMessage(data: { messageId: string, senderId: string, receiverId: string }): void {
    if (this.socket?.connected) {
      this.socket.emit('unsendMessage', data);
    }
  }

  // Check if user is online
  isUserOnline(userId: string): boolean {
    return this.onlineUsers.has(userId);
  }

  // Clean up on app close/logout
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnecting = false;
    this.connectionPromise = null;
  }

  // Request missed messages for a specific room
  requestMissedMessages(roomId: string): void {
    if (this.socket?.connected) {
      console.log(`Requesting missed messages for room: ${roomId}`);
      this.socket.emit('getMissedMessages', { roomId });
    } else {
      console.log('Cannot request missed messages: socket not connected');
      // Try to reconnect and then request
      this.initSocket().then(socket => {
        if (socket) {
          console.log(`Requesting missed messages after reconnection: ${roomId}`);
          socket.emit('getMissedMessages', { roomId });
        }
      });
    }
  }
  
  // Listen for connection state changes
  setupConnectionStateListeners(
    onConnect?: () => void,
    onDisconnect?: (reason: string) => void
  ): () => void {
    if (!this.socket) {
      console.error('No socket instance available');
      return () => {};
    }
    
    const connectHandler = () => {
      console.log('Socket connected in listener');
      if (onConnect) onConnect();
    };
    
    const disconnectHandler = (reason: string) => {
      console.log(`Socket disconnected in listener: ${reason}`);
      if (onDisconnect) onDisconnect(reason);
    };
    
    this.socket.on('connect', connectHandler);
    this.socket.on('disconnect', disconnectHandler);
    
    // Return cleanup function
    return () => {
      if (this.socket) {
        this.socket.off('connect', connectHandler);
        this.socket.off('disconnect', disconnectHandler);
      }
    };
  }
}

// Create a singleton instance
const socketService = new SocketService();
export default socketService; 