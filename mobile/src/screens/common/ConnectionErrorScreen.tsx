import React, { useContext, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator
} from 'react-native';
import { AuthContext } from '../../context/AuthContext';
import { Ionicons } from '@expo/vector-icons';

const ConnectionErrorScreen = () => {
  const { retryConnection, apiBaseUrl } = useContext(AuthContext);
  const [retrying, setRetrying] = useState(false);
  
  const handleRetry = async () => {
    setRetrying(true);
    try {
      await retryConnection();
    } catch (error) {
      console.error('Error retrying connection:', error);
    } finally {
      setRetrying(false);
    }
  };
  
  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name="cloud-offline" size={100} color="#e74c3c" />
        </View>
        
        <Text style={styles.title}>Không thể kết nối đến máy chủ</Text>
        
        <Text style={styles.message}>
          Ứng dụng không thể kết nối đến máy chủ. Vui lòng kiểm tra kết nối mạng
          và thử lại.
        </Text>
        
        <Text style={styles.serverUrl}>
          URL máy chủ: {apiBaseUrl}
        </Text>
        
        <TouchableOpacity
          style={styles.retryButton}
          onPress={handleRetry}
          disabled={retrying}
        >
          {retrying ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Ionicons name="refresh" size={20} color="#fff" />
              <Text style={styles.retryText}>Thử lại</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    padding: 20
  },
  content: {
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 15,
    padding: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4
  },
  iconContainer: {
    width: 150,
    height: 150,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#e74c3c',
    marginBottom: 15,
    textAlign: 'center'
  },
  message: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 22
  },
  serverUrl: {
    fontSize: 14,
    color: '#999',
    marginBottom: 25,
    textAlign: 'center'
  },
  retryButton: {
    flexDirection: 'row',
    backgroundColor: '#2196F3',
    paddingVertical: 12,
    paddingHorizontal: 25,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center'
  },
  retryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    marginLeft: 8
  }
});

export default ConnectionErrorScreen; 