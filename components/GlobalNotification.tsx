import React, { useEffect, useState } from 'react';
import { useNotification, NotificationType } from '../contexts/NotificationContext';
import { AlertCircle, CheckCircle, Info, X, XCircle } from 'lucide-react';

export const GlobalNotification: React.FC = () => {
    const { notification, clearNotification } = useNotification();
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (notification) {
            setVisible(true);
        } else {
            const timer = setTimeout(() => setVisible(false), 300); // Wait for fade out
            return () => clearTimeout(timer);
        }
    }, [notification]);

    if (!notification && !visible) return null;

    const getIcon = (type: NotificationType) => {
        switch (type) {
            case 'success': return <CheckCircle size={20} className="text-white" />;
            case 'error': return <XCircle size={20} className="text-white" />; // Red
            case 'warning': return <AlertCircle size={20} className="text-white" />;
            case 'info': default: return <Info size={20} className="text-white" />;
        }
    };

    const getBgColor = (type: NotificationType) => {
        switch (type) {
            case 'success': return 'bg-green-600';
            case 'error': return 'bg-red-600';
            case 'warning': return 'bg-orange-500';
            case 'info': default: return 'bg-blue-600';
        }
    };

    // Use current notification or keep last one during fade out
    const currentMsg = notification?.message || '';
    const currentType = notification?.type || 'info';

    return (
        <div
            className={`fixed top-12 right-4 z-[9999] transition-all duration-300 transform ${notification ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'
                }`}
            style={{ backdropFilter: 'none' }}
        >
            <div className={`${getBgColor(currentType)} text-white px-4 py-3 rounded shadow-lg flex items-center gap-3 min-w-[300px] max-w-[400px]`}>
                {getIcon(currentType)}
                <div className="flex-1 text-sm font-medium">{currentMsg}</div>
                <button
                    onClick={clearNotification}
                    className="text-white/80 hover:text-white p-1 rounded-full hover:bg-white/20 transition-colors"
                >
                    <X size={16} />
                </button>
            </div>
        </div>
    );
};
