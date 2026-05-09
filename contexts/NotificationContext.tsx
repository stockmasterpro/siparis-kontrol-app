import React, { createContext, useContext, useState, useCallback } from 'react';
import notificationSound from '../assets/notification.wav';

export type NotificationType = 'info' | 'success' | 'error' | 'warning';

interface Notification {
    id: string;
    message: string;
    type: NotificationType;
}

interface NotificationContextType {
    notification: Notification | null;
    showNotification: (message: string, type?: NotificationType) => void;
    clearNotification: () => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [notification, setNotification] = useState<Notification | null>(null);

    const playSound = useCallback(() => {
        try {
            // Try Electron main process first (more reliable)
            if ((window as any).electron) {
                (window as any).electron.showNotification({
                    title: '',
                    body: '',
                    playSound: true
                });
                return;
            }
            
            // Fallback to Web Audio API
            if (typeof Audio !== "undefined") {
                const audio = new Audio(notificationSound);
                audio.volume = 0.5;
                audio.play().catch(e => console.warn('Audio play failed (user interaction maybe needed):', e));
            }
        } catch (error) {
            console.error('Audio setup failed:', error);
        }
    }, []);

    const showNotification = useCallback((message: string, type: NotificationType = 'info') => {
        const id = Math.random().toString(36).substr(2, 9);
        setNotification({ id, message, type });
        playSound();

        // Auto clear after 4 seconds
        setTimeout(() => {
            setNotification(prev => (prev?.id === id ? null : prev));
        }, 4000);
    }, [playSound]);

    const clearNotification = useCallback(() => {
        setNotification(null);
    }, []);

    return (
        <NotificationContext.Provider value={{ notification, showNotification, clearNotification }}>
            {children}
        </NotificationContext.Provider>
    );
};

export const useNotification = () => {
    const context = useContext(NotificationContext);
    if (!context) {
        throw new Error('useNotification must be used within a NotificationProvider');
    }
    return context;
};
