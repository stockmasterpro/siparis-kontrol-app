import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<any, any> {
  // @ts-ignore
  public state: any = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  // @ts-ignore
  static getDerivedStateFromError(error: Error): any {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    // @ts-ignore
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    // @ts-ignore
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl p-8 w-full max-w-2xl">
            <div className="flex justify-center mb-6">
              <div className="bg-red-100 p-3 rounded-full">
                <AlertTriangle className="w-8 h-8 text-red-600" />
              </div>
            </div>
            <h2 className="text-2xl font-bold text-center text-gray-800 mb-4">
              Bir Hata Oluştu
            </h2>
            <p className="text-center text-gray-600 mb-4">
              Uygulamada beklenmeyen bir hata oluştu. Lütfen sayfayı yenileyin veya uygulamayı yeniden başlatın.
            </p>
            {this.state.error && (
              <div className="bg-gray-100 p-4 rounded mb-4">
                <p className="text-sm text-gray-700 font-mono break-all">
                  {this.state.error.toString()}
                </p>
              </div>
            )}
            <div className="flex gap-4 justify-center">
              <button
                onClick={this.handleReset}
                className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Tekrar Dene
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
              >
                Sayfayı Yenile
              </button>
            </div>
          </div>
        </div>
      );
    }

    // @ts-ignore
    return this.props.children;
  }
}

export default ErrorBoundary;

