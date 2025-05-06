import React, { useState, useEffect, useContext, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  Image,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRoute, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import axios from "axios";
import { AuthContext } from "../../context/AuthContext";
import { API_URL } from "../../config/constants";
import moment from "moment";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import AsyncStorage from "@react-native-async-storage/async-storage";
import socketService from "../../services/socketService";
import { Socket } from "socket.io-client";

interface Message {
  _id: string;
  sender: {
    _id: string;
    name: string;
    avt: string;
  };
  content: string;
  type: "text" | "image" | "video" | "audio" | "file";
  createdAt: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  reactions?: Record<string, string>;
  replyTo?: {
    _id: string;
    content: string;
    sender: string;
  };
  unsent: boolean;
  roomId?: string;
  receiver?: string | {
    _id: string;
    name?: string;
    avt?: string;
  };
}

interface RouteParams {
  chatId: string;
  chatName: string;
  contactId: string;
  contactAvatar: string;
  isGroup?: boolean;
}

const ChatDetailScreen = () => {
  const route = useRoute();
  const { chatId, chatName, contactId, contactAvatar, isGroup = false } =
    route.params as RouteParams;
  const navigation = useNavigation<any>();
  const { user } = useContext(AuthContext);

  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [typingTimeout, setTypingTimeout] = useState<NodeJS.Timeout | null>(null);
  const [groupInfo, setGroupInfo] = useState<any>(null);
  const [groupMembers, setGroupMembers] = useState<any[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const roomIdRef = useRef<string>('');

  // Initialize socket connection and room
  useEffect(() => {
    if (!user?._id || !contactId) {
      console.log("Missing user or contact ID");
      return;
    }

    // Create room ID - for groups use groupId, for individual chats use sorted user IDs
    let roomId;
    if (isGroup) {
      roomId = contactId; // For groups, contactId is the groupId
    } else {
      // For individual chats, create sorted room ID
      const userIds = [user._id, contactId].sort();
      roomId = `${userIds[0]}_${userIds[1]}`;
    }
    
    roomIdRef.current = roomId;
    console.log(`[SOCKET DEBUG] Setting up room: ${roomId}, isGroup: ${isGroup}`);

    // Handle socket setup in an async function with proper cleanup
    let cleanupListeners: (() => void) | null = null;
    let connectionStateCleanup: (() => void) | null = null;
    
    const setupSocketConnection = async () => {
      try {
        console.log("[SOCKET DEBUG] Setting up socket connection for chat detail");
        
        // Get socket instance from service
        socketRef.current = await socketService.initSocket();
        
        if (!socketRef.current) {
          console.error("[SOCKET DEBUG] Failed to get socket instance");
          Alert.alert(
            "Connection Error", 
            "Failed to establish connection. Messages may be delayed.",
            [{ text: "Retry", onPress: setupSocketConnection }]
          );
          return;
        }
        
        console.log(`[SOCKET DEBUG] Socket connected, joining room: ${roomId}`);
        
        // Join the chat room
        socketService.joinChatRoom(roomId);
        
        // Setup connection state listeners
        if (connectionStateCleanup) {
          connectionStateCleanup();
        }
        
        connectionStateCleanup = socketService.setupConnectionStateListeners(
          // On connect
          () => {
            console.log("[SOCKET DEBUG] Socket reconnected, rejoining room and requesting missed messages");
            socketService.joinChatRoom(roomId);
            socketService.requestMissedMessages(roomId);
          },
          // On disconnect
          (reason) => {
            console.log(`[SOCKET DEBUG] Socket disconnected: ${reason}`);
          }
        );
        
        // Request missed messages immediately
        socketService.requestMissedMessages(roomId);
        
        // Setup message handler - we need to store the handler function
        // to be able to remove it later
        const handleNewMessage = (newMessage: any) => {
          console.log(`[SOCKET DEBUG] Received message: ${JSON.stringify(newMessage)}`);
          
          // Extract key information from the message
          const messageId = newMessage._id;
          const tempId = newMessage._tempId || newMessage.tempId;
          const senderId = typeof newMessage.sender === 'object' ? newMessage.sender._id : newMessage.sender;
          const receiverId = typeof newMessage.receiver === 'object' ? newMessage.receiver._id : newMessage.receiver;
          const messageRoomId = newMessage.roomId || newMessage.groupId;
          
          // Validate message is for this conversation
          let isValidMessage = false;

          // For groups, check if message's groupId matches this group
          if (isGroup && newMessage.groupId && newMessage.groupId === contactId) {
            isValidMessage = true;
          }
          // For direct chat, check if message is for this conversation
          else if (!isGroup) {
            // Check direct roomId match
            if (messageRoomId && messageRoomId === roomId) {
              isValidMessage = true;
            }
            // Check sender/receiver match for this conversation
            else if ((senderId === user._id && receiverId === contactId) || 
                    (senderId === contactId && receiverId === user._id)) {
              isValidMessage = true;
            }
            // Check if IDs match room pattern
            else {
              const messageUserIds = [senderId, receiverId].sort().join('_');
              if (messageUserIds === roomId) {
                isValidMessage = true;
              }
            }
          }
            
          if (!isValidMessage) {
            console.log(`[SOCKET DEBUG] Message not for this room, ignoring. Message room info: ${senderId}_${receiverId} vs ${roomId}`);
            return;
          }
          
          // Log message details
          console.log(`[SOCKET DEBUG] Processing message: ID=${messageId}, TempID=${tempId}, Sender=${senderId}`);
          
          // Check if this message has already been processed
          if (socketService.isMessageReceived(messageId, tempId)) {
            console.log(`[SOCKET DEBUG] Ignoring duplicate message: ${messageId}/${tempId}`);
            return;
          }
          
          // Mark message as received
          socketService.markMessageReceived(messageId, tempId);
          
          // Normalize the message format for UI
          const normalizedMessage: Message = {
            _id: messageId || `temp-${Date.now()}`,
            content: newMessage.content || "",
            type: newMessage.type || "text",
            sender: {
              _id: typeof newMessage.sender === 'object' ? newMessage.sender._id : newMessage.sender,
              name: typeof newMessage.sender === 'object' ? 
                (newMessage.sender.name || `${newMessage.sender.firstName || ""} ${newMessage.sender.lastName || ""}`.trim()) : 
                (senderId === user._id ? (user?.name || "You") : chatName),
              avt: typeof newMessage.sender === 'object' ? 
                (newMessage.sender.avt || newMessage.sender.avatar || "") : 
                (senderId === user._id ? (user?.avt || "") : contactAvatar)
            },
            createdAt: newMessage.createdAt || new Date().toISOString(),
            reactions: newMessage.reactions || {},
            unsent: newMessage.unsent || false,
            fileUrl: newMessage.fileUrl || newMessage.file?.url || "",
            fileName: newMessage.fileName || newMessage.file?.name || "",
            roomId: newMessage.roomId || roomId
          };
          
          console.log(`[SOCKET DEBUG] Adding/updating message in UI: ${normalizedMessage._id}`);
          
          // Update messages state efficiently
          setMessages(prevMessages => {
            // Check for duplicates in current state
            if (prevMessages.some(msg => 
              msg._id === messageId || 
              (tempId && (msg._id === tempId || 
                (msg._id.startsWith('temp-') && tempId.startsWith('temp-') && msg._id === tempId)))
            )) {
              console.log(`[SOCKET DEBUG] Message already in state: ${messageId}`);
              
              // If message exists but as a temp, replace it with confirmed version
              if (tempId && tempId.startsWith('temp-')) {
                return prevMessages.map(msg => 
                  msg._id === tempId ? normalizedMessage : msg
                );
              }
              
              return prevMessages; // No change needed
            }
            
            // Find and replace temp message or add new message
            if (tempId && tempId.startsWith('temp-')) {
              // This is confirming a message we sent
              const tempIndex = prevMessages.findIndex(m => m._id === tempId);
              
              if (tempIndex !== -1) {
                console.log(`[SOCKET DEBUG] Replacing temp message: ${tempId}`);
                // Replace temp message with confirmed one
                const updatedMessages = [...prevMessages];
                updatedMessages[tempIndex] = normalizedMessage;
                return updatedMessages;
              }
            }
            
            // This is a new message, add it to the top
            console.log(`[SOCKET DEBUG] Adding new message to UI: ${normalizedMessage._id}`);
            return [normalizedMessage, ...prevMessages];
          });
          
          // Mark as read if message is from the other person
          if (senderId !== user._id) {
            console.log(`[SOCKET DEBUG] Marking message as read: ${messageId}`);
            socketService.markMessageAsRead({
              messageId: messageId,
              sender: senderId,
              receiver: user._id,
            });
          }
        };
        
        // Remove any existing event listeners first to prevent duplicates
        if (socketRef.current) {
          socketRef.current.off("receiveMessage");
        }
        
        // Add message handler
        socketRef.current.on("receiveMessage", handleNewMessage);
        console.log("[SOCKET DEBUG] Added receiveMessage event listener");
        
        // Setup other event handlers
        socketRef.current.on("messageStatusUpdate", (data: { messageId: string; status: string }) => {
          console.log(`[SOCKET DEBUG] Message status update: ${data.messageId} -> ${data.status}`);
          setMessages(prev =>
            prev.map(msg =>
              msg._id === data.messageId ? { ...msg, status: data.status } : msg
            )
          );
        });
        
        socketRef.current.on("messageReaction", (data: { messageId: string; userId: string; emoji: string }) => {
          console.log(`[SOCKET DEBUG] Message reaction: ${data.messageId} -> ${data.emoji}`);
          setMessages(prev =>
            prev.map(msg =>
              msg._id === data.messageId
                ? {
                    ...msg,
                    reactions: {
                      ...(msg.reactions || {}),
                      [data.userId]: data.emoji,
                    },
                  }
                : msg
            )
          );
        });
        
        socketRef.current.on("userTyping", (data: { userId: string }) => {
          if (!isGroup && data.userId === contactId) {
            setIsTyping(true);
          }
        });
        
        socketRef.current.on("userStoppedTyping", (data: { userId: string }) => {
          if (!isGroup && data.userId === contactId) {
            setIsTyping(false);
          }
        });
        
        socketRef.current.on("messageUnsent", (data: { messageId: string }) => {
          console.log(`[SOCKET DEBUG] Message unsent: ${data.messageId}`);
          setMessages(prev =>
            prev.map(msg =>
              msg._id === data.messageId
                ? { ...msg, content: "This message has been unsent", unsent: true }
                : msg
            )
          );
        });

        // Store cleanup function
        cleanupListeners = () => {
          if (socketRef.current) {
            console.log("[SOCKET DEBUG] Cleaning up socket event listeners");
            socketRef.current.off("receiveMessage", handleNewMessage);
            socketRef.current.off("messageStatusUpdate");
            socketRef.current.off("messageReaction");
            socketRef.current.off("userTyping");
            socketRef.current.off("userStoppedTyping");
            socketRef.current.off("messageUnsent");
          }
        };
      } catch (error) {
        console.error("[SOCKET DEBUG] Socket setup error:", error);
        Alert.alert(
          "Connection Error", 
          "Failed to establish connection. Messages may be delayed.",
          [{ text: "Retry", onPress: setupSocketConnection }]
        );
      }
    };
    
    // Call the setup function
    setupSocketConnection();
    
    // Return cleanup function that uses the stored reference
    return () => {
      if (cleanupListeners) {
        cleanupListeners();
      }
      if (connectionStateCleanup) {
        connectionStateCleanup();
      }
    };
  }, [user?._id, contactId, chatName, contactAvatar, isGroup]);

  // Load group info if it's a group chat
  useEffect(() => {
    if (isGroup && contactId) {
      const loadGroupInfo = async () => {
        try {
          const token = await AsyncStorage.getItem('token');
          
          if (!token) {
            console.error("No auth token available for loading group info");
            return;
          }
          
          const response = await axios.get(`${API_URL}/api/group/${contactId}`, {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
          
          if (response.data) {
            setGroupInfo(response.data);
            setGroupMembers(response.data.members || []);
          }
        } catch (error) {
          console.error("Failed to load group info:", error);
        }
      };
      
      loadGroupInfo();
    }
  }, [isGroup, contactId]);

  // Load initial messages with optimized approach
  useEffect(() => {
    const loadMessages = async () => {
      try {
        setLoading(true);
        
        // Get token from storage
        const token = await AsyncStorage.getItem('token');
        
        if (!token) {
          console.error("No auth token available for loading messages");
          Alert.alert("Error", "Authentication required. Please log in again.");
          return;
        }

        let messagesData = [];
        let response;
        
        // For group chats, use group messages endpoint
        if (isGroup) {
          try {
            response = await axios.get(`${API_URL}/api/group/${contactId}/messages`, {
              headers: {
                'Authorization': `Bearer ${token}`
              }
            });
            
            if (response.data) {
              messagesData = Array.isArray(response.data) ? response.data : 
                (response.data.messages ? response.data.messages : []);
                
              console.log(`Loaded ${messagesData.length} group messages`);
            }
          } catch (err) {
            console.log("Group messages endpoint failed:", err.message);
          }
        } else {
          // For individual chats, use existing logic
          // Create a consistent room ID based on sorted user IDs
          const sortedUserIds = [user?._id, contactId].sort();
          const roomId = `${sortedUserIds[0]}_${sortedUserIds[1]}`;
          
          // Try to get messages using direct endpoint first (fastest)
          try {
            // Use endpoint with a timeout to prevent long waits
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error("Loading messages timed out")), 3000)
            );
            
            const fetchPromise = axios.get(`${API_URL}/api/chat/messages/${sortedUserIds[0]}/${sortedUserIds[1]}`, {
              headers: {
                'Authorization': `Bearer ${token}`
              }
            });
            
            response = await Promise.race([fetchPromise, timeoutPromise]);
            
            if (response.data) {
              // Handle array or nested format
              messagesData = Array.isArray(response.data) ? response.data : 
                (response.data.messages ? response.data.messages : []);
                
              console.log(`Loaded ${messagesData.length} messages from direct endpoint`);
            }
          } catch (err) {
            console.log("Direct messages endpoint failed:", err.message);
            
            // If direct endpoint failed, try room-based endpoint as backup
            try {
              response = await axios.get(`${API_URL}/api/chat/room/${roomId}/messages`, {
                headers: {
                  'Authorization': `Bearer ${token}`
                }
              });
              
              if (response.data) {
                messagesData = Array.isArray(response.data) ? response.data : 
                  (response.data.messages ? response.data.messages : []);
                  
                console.log(`Loaded ${messagesData.length} messages from room endpoint`);
              }
            } catch (roomErr) {
              console.log("Room messages endpoint failed:", roomErr.message);
              
              // Last attempt - try with chat ID if provided
              if (chatId) {
                try {
                  response = await axios.get(`${API_URL}/api/chat/${chatId}/messages`, {
                    headers: {
                      'Authorization': `Bearer ${token}`
                    }
                  });
                  
                  if (response.data) {
                    messagesData = Array.isArray(response.data) ? response.data : 
                      (response.data.messages ? response.data.messages : []);
                      
                    console.log(`Loaded ${messagesData.length} messages from chat ID endpoint`);
                  }
                } catch (chatErr) {
                  console.log("Chat ID messages endpoint failed:", chatErr.message);
                }
              }
            }
          }
        }
        
        // Transform messages to consistent format
        const formattedMessages = messagesData.map((msg: any) => {
          // Normalize sender format
          let sender = msg.sender || {};
          if (typeof sender === 'string') {
            sender = {
              _id: sender,
              name: sender === user?._id ? (user?.name || "You") : chatName,
              avt: sender === user?._id ? (user?.avt || "") : contactAvatar
            };
          } else if (!sender._id && msg.senderId) {
            sender = {
              _id: msg.senderId,
              name: msg.senderId === user?._id ? (user?.name || "You") : chatName,
              avt: msg.senderId === user?._id ? (user?.avt || "") : contactAvatar
            };
          }
          
          return {
            _id: msg._id || msg.id || `temp-${Date.now()}-${Math.random()}`,
            content: msg.content || "",
            type: msg.type || "text",
            sender: {
              _id: sender._id || sender.id || "",
              name: sender.name || `${sender.firstName || ""} ${sender.lastName || ""}`.trim() || "Unknown",
              avt: sender.avt || sender.avatar || ""
            },
            createdAt: msg.createdAt || new Date().toISOString(),
            reactions: msg.reactions || {},
            unsent: msg.unsent || false,
            fileUrl: msg.fileUrl || msg.file?.url || "",
            fileName: msg.fileName || msg.file?.name || ""
          };
        });
        
        // Sort newest first for FlatList
        setMessages(formattedMessages.reverse());
      } catch (error: any) {
        console.error("Failed to load messages:", error);
        Alert.alert(
          "Error", 
          error.response?.data?.message || "Failed to load messages. Please try again.",
          [{ text: "Retry", onPress: loadMessages }]
        );
      } finally {
        setLoading(false);
      }
    };

    if (user?._id && contactId) {
      loadMessages();
    }
  }, [user?._id, contactId, chatId, chatName, contactAvatar, isGroup]);

  // Optimize typing indicator with debounce
  const handleTyping = (text: string) => {
    setMessageText(text);
    
    // Send typing indicator with debounce (only for direct chats)
    if (user?._id && contactId && !isGroup) {
      // Clear any existing timeout
      if (typingTimeout) {
        clearTimeout(typingTimeout);
      }
      
      // Send typing status
      socketService.sendTypingStatus({
        sender: user._id,
        receiver: contactId
      });
      
      // Set timeout to stop typing
      const timeout = setTimeout(() => {
        socketService.sendStopTypingStatus({
          sender: user._id,
          receiver: contactId
        });
      }, 1000); // Reduce from 2000ms to 1000ms for faster feedback
      
      setTypingTimeout(timeout);
    }
  };

  // Improved sendMessage function with better error handling
  const sendMessage = async (
    content: string,
    type = "text",
    fileUrl = "",
    fileName = "",
    fileSize = 0
  ) => {
    if ((type === "text" && !content.trim()) || sending) return;

    try {
      setSending(true);
      
      // Get token from storage
      const token = await AsyncStorage.getItem('token');
      
      if (!token) {
        console.error("No auth token available for sending message");
        Alert.alert("Error", "Authentication required. Please log in again.");
        return;
      }

      // Get room ID from ref to ensure consistency
      const roomId = roomIdRef.current || (isGroup ? 
        contactId : 
        `${[user?._id, contactId].sort().join('_')}`);

      // Create a temporary message ID to track this message
      const tempId = `temp-${Date.now()}`;

      // Add temporary message to UI immediately for better UX
      const tempMessage: Message = {
        _id: tempId,
        content,
        type: type as "text" | "image" | "video" | "audio" | "file",
        sender: {
          _id: user?._id || '',
          name: user?.name || 'You',
          avt: user?.avt || ''
        },
        createdAt: new Date().toISOString(),
        unsent: false,
        reactions: {},
        ...(fileUrl && { fileUrl }),
        ...(fileName && { fileName }),
        roomId // Add roomId to temp message
      };

      // Add temp message to start of the messages array
      setMessages(prevMessages => [tempMessage, ...prevMessages]);

      // Send message via socket first for fastest delivery
      let socketSuccess = false;
      if (user?._id && socketRef.current?.connected) {
        // Send stop typing status if not a group
        if (!isGroup) {
          socketService.sendStopTypingStatus({
            sender: user._id,
            receiver: contactId
          });
        }
        
        // Send message via socket
        if (isGroup) {
          // For group messages
          socketSuccess = socketService.sendGroupMessage({
            sender: user._id,
            groupId: contactId,
            content,
            tempId,
            type,
            roomId,
            ...(replyingTo && { replyToId: replyingTo._id }),
            ...(fileUrl && { fileUrl }),
            ...(fileName && { fileName }),
            ...(fileSize > 0 && { fileSize }),
          });
        } else {
          // For direct messages
          socketSuccess = socketService.sendMessage({
            sender: user._id,
            receiver: contactId,
            content,
            tempId,
            type,
            roomId,
            ...(replyingTo && { replyToId: replyingTo._id }),
            ...(fileUrl && { fileUrl }),
            ...(fileName && { fileName }),
            ...(fileSize > 0 && { fileSize }),
          });
        }
        
        console.log("Socket message send attempt:", socketSuccess ? "SUCCESS" : "FAILED");
      }

      // If socket send failed or socket is not connected, use REST API immediately
      if (!socketSuccess) {
        console.log("Using REST API to send message");
        try {
          let url, data;
          
          if (isGroup) {
            // Group message endpoint
            url = `${API_URL}/api/group/message`;
            data = {
              roomId,
              groupId: contactId,
              content,
              type,
              ...(replyingTo && { replyToId: replyingTo._id }),
              ...(fileUrl && { fileUrl }),
              ...(fileName && { fileName }),
              ...(fileSize > 0 && { fileSize }),
            };
          } else {
            // Direct message endpoint
            url = `${API_URL}/api/chat/messages`;
            data = {
              roomId,
              content,
              type,
              receiver: contactId,
              ...(replyingTo && { replyToId: replyingTo._id }),
              ...(fileUrl && { fileUrl }),
              ...(fileName && { fileName }),
              ...(fileSize > 0 && { fileSize }),
            };
          }
          
          const response = await axios.post(
            url,
            data,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            }
          );
          
          // If API send was successful, update the temp message with the real ID
          if (response.data && response.data._id) {
            setMessages(prevMessages => 
              prevMessages.map(msg => 
                msg._id === tempId ? 
                { ...msg, _id: response.data._id } : 
                msg
              )
            );
          }
          
          console.log("REST API message sent successfully");
        } catch (apiError) {
          console.error("API message send failed:", apiError);
          // Keep the temp message to show something was sent
        }
      }

      // Clear input after sending
      setMessageText("");
      setReplyingTo(null);
    } catch (error: any) {
      console.error("Failed to send message:", error);
      
      // Don't remove the temporary message, just mark it as failed
      setMessages(prevMessages => 
        prevMessages.map(msg => 
          msg._id.startsWith('temp-') ? 
          { ...msg, failed: true } : 
          msg
        )
      );
      
      Alert.alert(
        "Error", 
        error.response?.data?.message || "Failed to send message. Please try again."
      );
    } finally {
      setSending(false);
    }
  };

  const handleImagePicker = async () => {
    const permissionResult =
      await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permissionResult.granted) {
      Alert.alert(
        "Permission Required",
        "Need permission to access your photos"
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsEditing: false,
      quality: 0.8,
    });

    if (!result.canceled) {
      const uri = result.assets[0].uri;
      const fileName = uri.split("/").pop() || "image.jpg";
      const fileType = result.assets[0].type || "image";

      try {
        // Create form data for upload
        const formData = new FormData();
        formData.append("file", {
          uri,
          name: fileName,
          type: fileType === "image" ? "image/jpeg" : "video/mp4",
        } as any);
        formData.append("type", fileType);

        // Upload the file
        const response = await axios.post(
          `${API_URL}/api/chat/upload`,
          formData,
          {
            headers: {
              "Content-Type": "multipart/form-data",
            },
          }
        );

        const {
          fileUrl,
          fileId,
          fileName: serverFileName,
          fileSize,
        } = response.data;

        // Send the message with the file
        sendMessage(
          fileType === "image" ? "Photo" : "Video",
          fileType,
          fileUrl,
          serverFileName,
          fileSize
        );
      } catch (error) {
        console.error("Failed to upload file:", error);
        Alert.alert("Error", "Failed to upload file. Please try again.");
      }
    }
  };

  const handleDocumentPicker = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync();

      if (result.canceled) return;

      const asset = result.assets[0];
      const uri = asset.uri;
      const fileName = asset.name;
      const fileSize = asset.size || 0;

      // Create form data for upload
      const formData = new FormData();
      formData.append("file", {
        uri,
        name: fileName,
        type: asset.mimeType || "application/octet-stream",
      } as any);
      formData.append("type", "file");

      // Upload the file
      const response = await axios.post(
        `${API_URL}/api/chat/upload`,
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      );

      const {
        fileUrl,
        fileId,
        fileName: serverFileName,
        fileSize: serverFileSize,
      } = response.data;

      // Send the message with the file
      sendMessage(
        "Document",
        "file",
        fileUrl,
        serverFileName,
        serverFileSize || fileSize
      );
    } catch (error) {
      console.error("Failed to upload document:", error);
      Alert.alert("Error", "Failed to upload document. Please try again.");
    }
  };

  const startRecording = async () => {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      recordingRef.current = recording;
      setRecording(true);
    } catch (error) {
      console.error("Failed to start recording:", error);
      Alert.alert("Error", "Failed to start recording. Please try again.");
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;

    try {
      setRecording(false);
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI() || "";

      if (uri) {
        // Create form data for upload
        const formData = new FormData();
        formData.append("file", {
          uri,
          name: `audio_${Date.now()}.m4a`,
          type: "audio/m4a",
        } as any);
        formData.append("type", "audio");

        // Upload the file
        const response = await axios.post(
          `${API_URL}/api/chat/upload`,
          formData,
          {
            headers: {
              "Content-Type": "multipart/form-data",
            },
          }
        );

        const { fileUrl, fileId, fileName, fileSize } = response.data;

        // Send the message with the file
        sendMessage("Audio message", "audio", fileUrl, fileName, fileSize);
      }
    } catch (error) {
      console.error("Failed to stop recording:", error);
      Alert.alert(
        "Error",
        "Failed to process audio recording. Please try again."
      );
    } finally {
      recordingRef.current = null;
    }
  };

  const handleReplyTo = (message: Message) => {
    setReplyingTo(message);
  };

  const cancelReply = () => {
    setReplyingTo(null);
  };

  const handleReaction = async (messageId: string, emoji: string) => {
    if (!user?._id) return;
    
    socketService.addReaction({
      messageId,
      userId: user._id,
      emoji
    });
  };

  const handleUnsendMessage = async (message: Message) => {
    if (!user?._id) return;
    
    try {
      // Update UI first
      setMessages((prev) =>
        prev.map((msg) =>
          msg._id === message._id
            ? { ...msg, content: "Tin nhắn đã bị thu hồi", unsent: true }
            : msg
        )
      );
      
      // Then send via socket
      socketService.unsendMessage({
        messageId: message._id,
        senderId: user._id,
        receiverId: contactId
      });
      
      // Backup API call
      const token = await AsyncStorage.getItem('token');
      await axios.put(
        `${API_URL}/api/chat/messages/${message._id}/unsend`,
        { forEveryone: true },
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );
    } catch (error) {
      console.error("Failed to unsend message:", error);
      Alert.alert("Error", "Failed to unsend message. Please try again.");
    }
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isMine = item.sender._id === user?._id;
    const formattedTime = moment(item.createdAt).format("HH:mm");
    const isFailed = (item as any).failed;

    return (
      <View
        style={[
          styles.messageContainer,
          isMine ? styles.myMessageContainer : {},
        ]}
      >
        {!isMine && (
          <Image
            source={{
              uri:
                item.sender.avt ||
                `https://ui-avatars.com/api/?name=${encodeURIComponent(
                  item.sender.name
                )}`,
            }}
            style={styles.messageSenderAvatar}
          />
        )}

        <View
          style={[
            styles.messageBubble, 
            isMine ? styles.myMessageBubble : {},
            isFailed ? styles.failedMessage : {}
          ]}
        >
          {item.replyTo && (
            <View style={styles.replyContainer}>
              <Text style={styles.replyText} numberOfLines={1}>
                {item.replyTo.content}
              </Text>
            </View>
          )}

          {item.unsent ? (
            <Text style={styles.unsent}>This message has been unsent</Text>
          ) : item.type === "text" ? (
            <Text style={styles.messageText}>{item.content}</Text>
          ) : item.type === "image" ? (
            <View>
              <Image
                source={{ uri: item.fileUrl }}
                style={styles.imageMessage}
                resizeMode="cover"
              />
            </View>
          ) : item.type === "video" ? (
            <View style={styles.fileMessage}>
              <Ionicons name="videocam" size={24} color="#fff" />
              <Text style={styles.fileMessageText}>Video</Text>
            </View>
          ) : item.type === "audio" ? (
            <View style={styles.fileMessage}>
              <Ionicons name="mic" size={24} color="#fff" />
              <Text style={styles.fileMessageText}>Audio message</Text>
            </View>
          ) : item.type === "file" ? (
            <View style={styles.fileMessage}>
              <Ionicons name="document" size={24} color="#fff" />
              <Text style={styles.fileMessageText}>
                {item.fileName || "Document"}
              </Text>
            </View>
          ) : null}

          <Text style={styles.messageTime}>
            {formattedTime}
            {isFailed && " (Failed)"}
          </Text>

          {Object.keys(item.reactions || {}).length > 0 && (
            <View style={styles.reactionsContainer}>
              {Object.entries(item.reactions || {}).map(([userId, emoji]) => (
                <Text key={userId} style={styles.reaction}>
                  {emoji}
                </Text>
              ))}
            </View>
          )}
        </View>

        <TouchableOpacity
          style={styles.messageOptions}
          onPress={() => {
            Alert.alert("Message Options", "Choose an action", [
              { text: "Reply", onPress: () => handleReplyTo(item) },
              {
                text: "React 👍",
                onPress: () => handleReaction(item._id, "👍"),
              },
              {
                text: "React ❤️",
                onPress: () => handleReaction(item._id, "❤️"),
              },
              ...(isMine && !item.unsent
                ? [
                    {
                      text: "Unsend",
                      onPress: () => handleUnsendMessage(item),
                    },
                  ]
                : []),
              { text: "Cancel", style: "cancel" },
            ]);
          }}
        >
          <Ionicons name="ellipsis-vertical" size={16} color="#999" />
        </TouchableOpacity>
      </View>
    );
  };

  // Show group info
  const showGroupInfo = () => {
    if (isGroup && groupInfo) {
      navigation.navigate('GroupInfo', {
        groupId: contactId,
        groupName: chatName,
        groupAvatar: contactAvatar
      });
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={24} color="#2196F3" />
        </TouchableOpacity>

        <TouchableOpacity 
          style={styles.headerMain}
          onPress={isGroup ? showGroupInfo : undefined}
        >
          <Image
            source={{
              uri:
                contactAvatar ||
                `https://ui-avatars.com/api/?name=${encodeURIComponent(
                  chatName
                )}`,
            }}
            style={styles.headerAvatar}
          />

          <View style={styles.headerInfo}>
            <Text style={styles.headerName}>{chatName}</Text>
            {isGroup ? (
              <Text style={styles.headerStatus}>
                {groupMembers.length} members
              </Text>
            ) : (
              <Text style={styles.headerStatus}>Online</Text>
            )}
          </View>
        </TouchableOpacity>

        {!isGroup && (
          <>
            <TouchableOpacity style={styles.headerButton}>
              <Ionicons name="call-outline" size={24} color="#2196F3" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.headerButton}>
              <Ionicons name="videocam-outline" size={24} color="#2196F3" />
            </TouchableOpacity>
          </>
        )}

        {isGroup && (
          <TouchableOpacity style={styles.headerButton} onPress={showGroupInfo}>
            <Ionicons name="information-circle-outline" size={24} color="#2196F3" />
          </TouchableOpacity>
        )}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardAvoidingView}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        {loading ? (
          <ActivityIndicator
            style={styles.loader}
            size="large"
            color="#2196F3"
          />
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(item) => item._id}
            style={styles.messagesList}
            contentContainerStyle={styles.messagesListContent}
            inverted
          />
        )}

        {isTyping && (
          <View style={styles.typingIndicator}>
            <Text style={styles.typingText}>{chatName} đang nhập...</Text>
          </View>
        )}

        {replyingTo && (
          <View style={styles.replyBar}>
            <View style={styles.replyInfo}>
              <Text style={styles.replyingTo}>
                Replying to {replyingTo.sender.name}
              </Text>
              <Text style={styles.replyContent} numberOfLines={1}>
                {replyingTo.content}
              </Text>
            </View>
            <TouchableOpacity onPress={cancelReply} style={styles.cancelReply}>
              <Ionicons name="close" size={20} color="#666" />
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.inputContainer}>
          <TouchableOpacity
            style={styles.attachButton}
            onPress={handleImagePicker}
          >
            <Ionicons name="image-outline" size={24} color="#2196F3" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.attachButton}
            onPress={handleDocumentPicker}
          >
            <Ionicons name="document-outline" size={24} color="#2196F3" />
          </TouchableOpacity>

          <TextInput
            style={styles.input}
            placeholder="Type a message..."
            value={messageText}
            onChangeText={handleTyping}
            multiline
          />

          {messageText.trim() ? (
            <TouchableOpacity
              style={styles.sendButton}
              onPress={() => sendMessage(messageText)}
              disabled={sending}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="send" size={20} color="#fff" />
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.recordButton}
              onPressIn={startRecording}
              onPressOut={stopRecording}
            >
              <Ionicons
                name={recording ? "radio-button-on" : "mic-outline"}
                size={24}
                color={recording ? "#ff0000" : "#2196F3"}
              />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 40,
    paddingBottom: 10,
    paddingHorizontal: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  backButton: {
    padding: 5,
  },
  headerMain: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginLeft: 5,
  },
  headerInfo: {
    flex: 1,
    marginLeft: 10,
  },
  headerName: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#333",
  },
  headerStatus: {
    fontSize: 12,
    color: "#4caf50",
  },
  headerButton: {
    paddingHorizontal: 10,
  },
  keyboardAvoidingView: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  messagesList: {
    flex: 1,
    padding: Platform.OS === "android" ? 5 : 10,
  },
  messagesListContent: {
    paddingTop: 10,
    paddingBottom: Platform.OS === "android" ? 5 : 10,
  },
  messageContainer: {
    flexDirection: "row",
    marginBottom: 15,
    alignItems: "flex-end",
  },
  myMessageContainer: {
    justifyContent: "flex-end",
  },
  messageSenderAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginRight: 5,
  },
  messageBubble: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 10,
    maxWidth: "75%",
    minWidth: 50,
    borderWidth: 1,
    borderColor: "#eee",
  },
  myMessageBubble: {
    backgroundColor: "#e3f2fd",
  },
  replyContainer: {
    padding: 8,
    borderLeftWidth: 3,
    borderLeftColor: "#2196F3",
    backgroundColor: "rgba(33, 150, 243, 0.1)",
    borderRadius: 5,
    marginBottom: 5,
  },
  replyText: {
    fontSize: 12,
    color: "#555",
  },
  messageText: {
    fontSize: 16,
    color: "#333",
  },
  messageTime: {
    fontSize: 10,
    color: "#999",
    alignSelf: "flex-end",
    marginTop: 5,
  },
  unsent: {
    fontStyle: "italic",
    color: "#999",
  },
  imageMessage: {
    width: 200,
    height: 200,
    borderRadius: 10,
  },
  fileMessage: {
    flexDirection: "row",
    alignItems: "center",
    padding: 5,
  },
  fileMessageText: {
    marginLeft: 5,
    fontSize: 14,
    color: "#333",
  },
  reactionsContainer: {
    flexDirection: "row",
    marginTop: 5,
    alignItems: "center",
  },
  reaction: {
    fontSize: 16,
    marginRight: 3,
  },
  messageOptions: {
    marginLeft: 5,
    marginRight: 5,
    padding: 5,
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    padding: 10,
    paddingBottom: Platform.OS === "android" ? 5 : 10,
    borderTopWidth: 1,
    borderTopColor: "#eee",
  },
  attachButton: {
    padding: 5,
    marginRight: 5,
  },
  input: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 8,
    maxHeight: 100,
    fontSize: 16,
  },
  sendButton: {
    backgroundColor: "#2196F3",
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 10,
  },
  recordButton: {
    padding: 5,
    marginLeft: 10,
  },
  replyBar: {
    flexDirection: "row",
    backgroundColor: "#f5f5f5",
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: "#eee",
    alignItems: "center",
  },
  replyInfo: {
    flex: 1,
  },
  replyingTo: {
    fontSize: 12,
    color: "#2196F3",
    fontWeight: "bold",
  },
  replyContent: {
    fontSize: 14,
    color: "#666",
  },
  cancelReply: {
    padding: 5,
  },
  loader: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  typingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#eee",
  },
  typingText: {
    fontSize: 12,
    color: "#666",
  },
  failedMessage: {
    borderColor: '#ff6b6b',
    backgroundColor: '#ffeeee',
  },
});

export default ChatDetailScreen;
