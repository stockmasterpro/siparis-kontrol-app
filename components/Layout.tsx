import React from 'react';
import { User, UserRole } from '../types';
import { LayoutDashboard, Package, ShoppingCart, Settings, LogOut, Minus, MessageSquare, Monitor, RotateCw, Maximize, Minimize } from 'lucide-react';
import { GlobalNotification } from './GlobalNotification';

interface LayoutProps {
  children: React.ReactNode;
  user: User;
  onLogout: () => void;
  currentPage: string;
  onNavigate: (page: string) => void;
  currentOrderTab?: string;
  orderCounts?: {
    active: number;
    cancelled: number;
    suspended: number;
    returned: number;
    newQuestions?: number;
    returnClaims?: number;
  };
  canLogout?: boolean;
}


export const Layout: React.FC<LayoutProps> = ({ children, user, onLogout, currentPage, onNavigate, currentOrderTab, orderCounts, canLogout }) => {
  const [isFullScreen, setIsFullScreen] = React.useState(false);

  React.useEffect(() => {
    const checkFullScreen = async () => {
      try {
        // @ts-ignore
        if (window.require) {
          // @ts-ignore
          const { ipcRenderer } = window.require('electron');
          const status = await ipcRenderer.invoke('is-fullscreen');
          setIsFullScreen(status);
        }
      } catch (e) {
        console.warn('Fullscreen check failed:', e);
      }
    };
    checkFullScreen();
  }, []);

  const handleToggleFullscreen = async () => {
    try {
      // @ts-ignore
      if (window.require) {
        // @ts-ignore
        const { ipcRenderer } = window.require('electron');
        const newState = await ipcRenderer.invoke('toggle-fullscreen');
        if (newState !== undefined) {
          setIsFullScreen(newState);
        }
      }
    } catch (e) {
      console.error('Fullscreen toggle failed:', e);
    }
  };

  const menuItems = [
    { id: 'dashboard', label: 'Ana Sayfa', icon: LayoutDashboard, role: UserRole.USER },
    { id: 'products', label: 'Ürün Yönetimi', icon: Package, role: UserRole.USER },
    {
      id: 'orders',
      label: 'Sipariş Yönetimi',
      icon: ShoppingCart,
      role: UserRole.USER,
      subItems: [
        { id: 'active', label: 'Siparişler' },
        { id: 'cancelled', label: 'İptal Edilenler' },
        { id: 'suspended', label: 'Askıdakiler' },
        { id: 'returned', label: 'İade Alınanlar' }
      ]
    },
    {
      id: 'questions',
      label: 'Müşteri Soruları',
      icon: MessageSquare,
      role: UserRole.USER,
      subItems: [
        { id: 'new', label: 'Yeni Sorular' }
      ]
    },
    {
      id: 'return-management',
      label: 'İade Yönetimi',
      icon: RotateCw,
      role: UserRole.USER,
      subItems: [
        { id: 'actions', label: 'Aksiyondaki Siparişler' }
      ]
    },
    { id: 'settings', label: 'Ayarlar', icon: Settings, role: UserRole.ADMIN },
  ];

  return (
    <div className="flex flex-col h-screen w-screen bg-gray-200 text-sm">
      <GlobalNotification />
      {/* Windows Title Bar Simulation */}
      <div className="h-8 bg-[#3c3c3c] flex items-center justify-between select-none text-white pl-3 pr-0 z-50">
        <div className="flex items-center gap-2">
          <Monitor size={14} className="text-blue-400" />
          <span className="text-xs font-normal tracking-wide">E- Ticaret ve Perakende Yönetim</span>
        </div>
        <div className="flex items-center">
          <button
            onClick={handleToggleFullscreen}
            className="h-8 px-4 flex items-center justify-center hover:bg-[#4a4a4a] transition-colors text-white/70 hover:text-white no-drag"
            style={{ WebkitAppRegion: 'no-drag' }}
            title={isFullScreen ? 'Tam Ekrandan Çık' : 'Tam Ekrana Geç'}
          >
            {isFullScreen ? <Minimize size={14} /> : <Maximize size={14} />}
          </button>
        </div>
      </div>

      {/* Main App Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Rigid Sidebar */}
        <div className="w-56 bg-[#f3f4f6] border-r border-gray-400 flex flex-col">
          <div className="p-2 border-b border-gray-300 bg-gray-100">
            <div className="font-bold text-gray-700 px-2 py-1 truncate">
              {user.name}
            </div>
            <div className="text-xs text-gray-500 px-2 truncate">
              {user.role === UserRole.ADMIN ? 'Sistem Yöneticisi' : 'Operatör'}
            </div>
          </div>

          <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
            {menuItems.map((item) => {
              if (user.role !== UserRole.ADMIN && item.role === UserRole.ADMIN && item.id === 'settings') return null;
              const isActive = currentPage === item.id;
              return (
                <div key={item.id}>
                  <button
                    onClick={() => {
                      if (item.subItems) {
                        onNavigate(`${item.id}:${item.subItems[0].id}`);
                      } else {
                        onNavigate(item.id);
                      }
                    }}
                    className={`w-full flex items-center px-3 py-2 text-xs font-medium border border-transparent ${isActive && !item.subItems
                      ? 'bg-blue-200 text-blue-900 border-blue-300'
                      : isActive && item.subItems
                        ? 'bg-gray-200 text-blue-900 font-bold'
                        : 'text-gray-700 hover:bg-gray-200 hover:border-gray-300'
                      }`}
                  >
                    <item.icon className={`w-4 h-4 mr-2 ${isActive ? 'text-blue-700' : 'text-gray-500'}`} />
                    {item.label}
                  </button>

                  {/* Sub-items */}
                  {item.subItems && (
                    <div className="mt-1 ml-4 space-y-1">
                      {item.subItems.map(sub => {
                        let count = 0;
                        if (item.id === 'orders') {
                          count = orderCounts?.[sub.id as keyof typeof orderCounts] || 0;
                        } else if (item.id === 'questions' && sub.id === 'new') {
                          count = orderCounts?.newQuestions || 0;
                        } else if (item.id === 'return-management' && sub.id === 'actions') {
                          count = (orderCounts as any)?.returnClaims || 0;
                        }

                        return (
                          <button
                            key={sub.id}
                            onClick={() => onNavigate(`${item.id}:${sub.id}`)}
                            className={`w-full flex items-center justify-between px-3 py-1.5 text-[11px] border border-transparent ${isActive && currentOrderTab === sub.id
                              ? 'bg-blue-100 text-blue-800 border-blue-200 font-semibold'
                              : 'text-gray-600 hover:bg-gray-200'
                              }`}
                          >
                            <div className="flex items-center">
                              <Minus size={10} className="mr-2 opacity-50" />
                              {sub.label}
                            </div>
                            {count > 0 && sub.id !== 'cancelled' && sub.id !== 'returned' && sub.id !== 'answered' && (
                              <span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold min-w-[16px] text-center">
                                {count}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          {(user.id !== 'system-admin' || canLogout) && (
            <div className="p-2 border-t border-gray-300">
              <button
                onClick={onLogout}
                className="w-full flex items-center justify-center px-3 py-1 bg-gray-200 border border-gray-400 text-gray-700 hover:bg-red-100 hover:border-red-300 hover:text-red-700 text-xs transition-colors"
              >
                <LogOut className="w-3 h-3 mr-2" />
                Oturumu Kapat
              </button>
            </div>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col bg-gray-100 overflow-hidden relative">
          <main className="flex-1 p-2 overflow-auto relative">
            {/* Inner Window Effect */}
            <div className="h-full w-full bg-white border border-gray-400 shadow-sm flex flex-col">
              <div className="h-8 bg-gray-100 border-b border-gray-300 flex items-center px-4 font-semibold text-gray-700 select-none text-xs">
                {menuItems.find(m => m.id === currentPage)?.label} Panel
                {currentOrderTab && (
                  <span className="ml-2 text-gray-400 font-normal">› {
                    menuItems.find(m => m.id === currentPage)?.subItems?.find(s => s.id === currentOrderTab)?.label
                  }</span>
                )}
              </div>
              <div className="flex-1 overflow-auto p-2">
                {children}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};
