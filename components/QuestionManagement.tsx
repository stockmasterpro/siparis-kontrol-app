import React, { useState, useMemo } from 'react';
import { Database, Question, QuestionStatus, QuickAnswer, ApiConfig } from '../types';
import { Search, MessageSquare, CheckCircle, Clock, ExternalLink, Send, Plus, Trash2, ChevronLeft, ChevronRight, Image as ImageIcon, AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown, RotateCw, Edit, Save, X } from 'lucide-react';
import { format } from 'date-fns';
import { tr } from 'date-fns/locale';
import { answerMarketplaceQuestion } from '../services/integration';
import { v4 as uuidv4 } from 'uuid';

interface QuestionManagementProps {
    db: Database;
    onUpdateDB: (newDB: Database | ((prev: Database) => Database)) => void;
    onSyncNow?: () => Promise<void>;
}

export const QuestionManagement: React.FC<QuestionManagementProps> = ({ db, onUpdateDB, onSyncNow }) => {
    const [activeTab, setActiveTab] = useState<'questions' | 'quick-answers'>('questions');
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'createdDate', direction: 'desc' });
    const [isManualSyncing, setIsManualSyncing] = useState(false);
    const [selectedQuestion, setSelectedQuestion] = useState<Question | null>(null);
    const [answerText, setAnswerText] = useState('');
    const [isAnswering, setIsAnswering] = useState(false);
    const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
    const [storeFilter, setStoreFilter] = useState<string>('all');
    const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
    const [bulkAnswerText, setBulkAnswerText] = useState('');
    const [isBulkAnswering, setIsBulkAnswering] = useState(false);

    // Hazır Cevap State'leri
    const [qaForm, setQaForm] = useState<QuickAnswer>({ id: '', title: '', text: '' });
    const [isQAModalOpen, setIsQAModalOpen] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

    // Pagination reset on search
    React.useEffect(() => {
        setCurrentPage(1);
    }, [searchTerm, storeFilter]);

    const safeFormatDate = (dateStr: string | number | undefined, formatStr: string = 'd MMMM yyyy HH:mm') => {
        if (!dateStr) return 'Tarih Belirtilmemiş';
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return 'Geçersiz Tarih';
            return format(date, formatStr, { locale: tr });
        } catch (e) {
            return 'Hatalı Tarih';
        }
    };

    const openProductLink = async (url?: string) => {
        const target = (url || '').trim();
        if (!target) return;
        try {
            if (window.electron?.openExternal) {
                await window.electron.openExternal(target);
            } else {
                window.open(target, '_blank', 'noreferrer');
            }
        } catch {
            window.open(target, '_blank', 'noreferrer');
        }
    };

    const itemsPerPage = 25;

    // Filter and Sort questions
    const filteredQuestions = useMemo(() => {
        return (db.questions || [])
            .filter(q => q.status === QuestionStatus.WAITING_FOR_ANSWER)
            .filter(q =>
                (q.text || '').toLowerCase().includes(searchTerm.toLowerCase())
            )
            .filter(q => storeFilter === 'all' || q.storeName === storeFilter)
            .sort((a, b) => {
                const aVal = (a as any)[sortConfig.key] || '';
                const bVal = (b as any)[sortConfig.key] || '';

                if (sortConfig.key === 'createdDate') {
                    const timeA = new Date(aVal).getTime();
                    const timeB = new Date(bVal).getTime();
                    return sortConfig.direction === 'asc' ? timeA - timeB : timeB - timeA;
                }

                const comparison = aVal.toString().localeCompare(bVal.toString(), 'tr');
                return sortConfig.direction === 'asc' ? comparison : -comparison;
            });
    }, [db.questions, searchTerm, sortConfig, storeFilter]);

    // Pagination
    const totalPages = Math.ceil(filteredQuestions.length / itemsPerPage);
    const paginatedQuestions = filteredQuestions.slice(
        (currentPage - 1) * itemsPerPage,
        currentPage * itemsPerPage
    );

    const handlePrevious = () => {
        const index = filteredQuestions.findIndex(q => q.id === selectedQuestion?.id);
        if (index > 0) {
            setSelectedQuestion(filteredQuestions[index - 1]);
            setAnswerText('');
        }
    };

    const handleNext = () => {
        const index = filteredQuestions.findIndex(q => q.id === selectedQuestion?.id);
        if (index < filteredQuestions.length - 1) {
            setSelectedQuestion(filteredQuestions[index + 1]);
            setAnswerText('');
        }
    };

    const handleAnswer = async () => {
        if (!selectedQuestion || !answerText.trim()) return;

        setIsAnswering(true);
        try {
            const config = db.apiConfigs.find(c => c.storeName === selectedQuestion.storeName);
            if (!config) throw new Error('Mağaza yapılandırması bulunamadı.');

            const success = await answerMarketplaceQuestion(config, selectedQuestion.marketplaceQuestionId, answerText);

            // Find next question before closing/updating
            const currentIndex = filteredQuestions.findIndex(q => q.id === selectedQuestion.id);
            const nextQuestion = filteredQuestions[currentIndex + 1];

            onUpdateDB(prev => ({
                ...prev,
                questions: (prev.questions || []).map(q =>
                    q.id === selectedQuestion.id
                        ? { ...q, status: QuestionStatus.ANSWERED, answer: answerText }
                        : q
                )
            }));

            setNotification({ type: 'success', message: 'Cevap başarıyla gönderildi.' });
            setAnswerText('');

            if (nextQuestion) {
                setSelectedQuestion(nextQuestion);
            } else {
                setSelectedQuestion(null);
            }
        } catch (error: any) {
            setNotification({ type: 'error', message: error.message || 'Cevap gönderilirken bir hata oluştu.' });
        } finally {
            setIsAnswering(false);
        }
    };

    const useQuickAnswer = (text: string) => {
        setAnswerText(text);
    };

    const toggleSelectAll = () => {
        if (selectedQuestionIds.size === paginatedQuestions.length && paginatedQuestions.length > 0) {
            setSelectedQuestionIds(new Set());
        } else {
            const newSet = new Set(selectedQuestionIds);
            paginatedQuestions.forEach(q => {
                if (q.status === QuestionStatus.WAITING_FOR_ANSWER) {
                    newSet.add(q.id);
                }
            });
            setSelectedQuestionIds(newSet);
        }
    };

    const toggleSelectQuestion = (id: string) => {
        const newSet = new Set(selectedQuestionIds);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        setSelectedQuestionIds(newSet);
    };

    const handleBulkAnswer = async () => {
        if (selectedQuestionIds.size === 0 || !bulkAnswerText.trim()) return;

        setIsBulkAnswering(true);
        let successCount = 0;
        let failCount = 0;

        try {
            const idsArray = Array.from(selectedQuestionIds);

            for (const id of idsArray) {
                const question = db.questions.find(q => q.id === id);
                if (!question) continue;

                const config = db.apiConfigs.find(c => c.storeName === question.storeName);
                if (!config) {
                    failCount++;
                    continue;
                }

                const success = await answerMarketplaceQuestion(config, question.marketplaceQuestionId, bulkAnswerText);
                if (success) {
                    successCount++;
                    onUpdateDB(prev => ({
                        ...prev,
                        questions: (prev.questions || []).map(q =>
                            q.id === id ? { ...q, status: QuestionStatus.ANSWERED, answer: bulkAnswerText } : q
                        )
                    }));
                } else {
                    failCount++;
                }
            }

            setNotification({
                type: successCount > 0 ? 'success' : 'error',
                message: `${successCount} soru cevaplandı. ${failCount} hata oluştu.`
            });
            setSelectedQuestionIds(new Set());
            setIsBulkModalOpen(false);
            setBulkAnswerText('');
        } catch (error: any) {
            setNotification({ type: 'error', message: 'Toplu işlem sırasında hata oluştu.' });
        } finally {
            setIsBulkAnswering(false);
        }
    };

    const availableStores = useMemo(() => {
        const stores = (db.questions || []).map(q => q.storeName);
        return Array.from(new Set(stores)).filter(Boolean);
    }, [db.questions]);

    return (
        <div className="flex flex-col h-full space-y-4">
            {/* Header & Tabs */}
            <div className="flex bg-white border-b overflow-hidden rounded-t-lg">
                <button
                    onClick={() => setActiveTab('questions')}
                    className={`px-6 py-2.5 text-xs font-extrabold uppercase tracking-tight transition-all duration-200 border-r ${activeTab === 'questions' ? 'bg-white text-blue-700 border-t-2 border-t-blue-600' : 'bg-gray-50 text-gray-500 hover:bg-gray-100 border-t-2 border-t-transparent'}`}
                >
                    <div className="flex items-center gap-2">
                        <MessageSquare size={14} />
                        Müşteri Soruları
                        <span className="bg-blue-100 text-blue-700 text-[10px] px-1.5 py-0.5 rounded-full">
                            {(db.questions || []).filter(q => q.status === QuestionStatus.WAITING_FOR_ANSWER).length}
                        </span>
                    </div>
                </button>
                <button
                    onClick={() => setActiveTab('quick-answers')}
                    className={`px-6 py-2.5 text-xs font-extrabold uppercase tracking-tight transition-all duration-200 border-r ${activeTab === 'quick-answers' ? 'bg-white text-blue-700 border-t-2 border-t-blue-600' : 'bg-gray-50 text-gray-500 hover:bg-gray-100 border-t-2 border-t-transparent'}`}
                >
                    <div className="flex items-center gap-2">
                        <Clock size={14} />
                        Hazır Cevaplar
                        <span className="bg-gray-200 text-gray-600 text-[10px] px-1.5 py-0.5 rounded-full">
                            {db.settings.quickAnswers?.length || 0}
                        </span>
                    </div>
                </button>
            </div>
            {/* Questions Tab Content */}
            {activeTab === 'questions' && (
                <>
                    {/* Header Area */}
                    <div className="flex items-center justify-between bg-gray-50 p-4 border-b">
                        <div className="flex items-center gap-4">
                            <h2 className="text-lg font-bold text-gray-800 flex items-center">
                                <MessageSquare className="w-5 h-5 mr-2 text-blue-600" />
                                Müşteri Soruları
                                <span className="ml-3 bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full border border-blue-200">
                                    {(db.questions || []).filter(q => q.status === QuestionStatus.WAITING_FOR_ANSWER).length} Cevap Bekliyor
                                </span>
                            </h2>
                        </div>

                        <div className="flex items-center space-x-3">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                                <input
                                    type="text"
                                    placeholder="Müşteri Sorularında Ara..."
                                    className="pl-10 pr-4 py-2 border rounded-lg text-sm w-48 focus:ring-2 focus:ring-blue-500 outline-none"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                            </div>

                            <select
                                className="border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                                value={storeFilter}
                                onChange={(e) => { setStoreFilter(e.target.value); setCurrentPage(1); }}
                            >
                                <option value="all">Tüm Mağazalar</option>
                                {availableStores.map(store => (
                                    <option key={store} value={store}>{store}</option>
                                ))}
                            </select>

                            {selectedQuestionIds.size > 0 && (
                                <button
                                    onClick={() => setIsBulkModalOpen(true)}
                                    className="bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 text-sm shadow-sm animate-in fade-in slide-in-from-right-4"
                                >
                                    <Send size={16} /> Toplu Cevapla ({selectedQuestionIds.size})
                                </button>
                            )}

                            {onSyncNow && (
                                <button
                                    onClick={async () => {
                                        setIsManualSyncing(true);
                                        try {
                                            await onSyncNow();
                                        } finally {
                                            setIsManualSyncing(false);
                                        }
                                    }}
                                    disabled={isManualSyncing}
                                    className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold shadow-sm disabled:bg-gray-400 transition-all"
                                >
                                    <RotateCw size={16} className={isManualSyncing ? 'animate-spin' : ''} />
                                    {isManualSyncing ? 'Sorgulanıyor...' : 'Soruları Çek'}
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Questions Table */}
                    <div className="flex-1 overflow-auto px-4">
                        <table className="w-full text-left border-collapse bg-white rounded-lg shadow-sm">
                            <thead className="bg-gray-100 border-b sticky top-0 z-10">
                                <tr>
                                    <th className="px-4 py-3 text-left w-10">
                                        <input
                                            type="checkbox"
                                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                            checked={selectedQuestionIds.size === paginatedQuestions.length && paginatedQuestions.length > 0}
                                            onChange={toggleSelectAll}
                                        />
                                    </th>
                                    <th
                                        className="px-4 py-3 text-xs font-bold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-200 transition-colors"
                                        onClick={() => setSortConfig(prev => ({ key: 'storeName', direction: prev.key === 'storeName' && prev.direction === 'asc' ? 'desc' : 'asc' }))}
                                    >
                                        <div className="flex items-center gap-1">
                                            Mağaza / Müşteri
                                            {sortConfig.key === 'storeName' ? (sortConfig.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-30" />}
                                        </div>
                                    </th>
                                    <th
                                        className="px-4 py-3 text-xs font-bold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-200 transition-colors"
                                        onClick={() => setSortConfig(prev => ({ key: 'productName', direction: prev.key === 'productName' && prev.direction === 'asc' ? 'desc' : 'asc' }))}
                                    >
                                        <div className="flex items-center gap-1">
                                            Ürün Görseli / Bilgisi
                                            {sortConfig.key === 'productName' ? (sortConfig.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-30" />}
                                        </div>
                                    </th>
                                    <th className="px-4 py-3 text-xs font-bold text-gray-600 uppercase tracking-wider w-1/3">Soru</th>
                                    <th
                                        className="px-4 py-3 text-xs font-bold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-200 transition-colors"
                                        onClick={() => setSortConfig(prev => ({ key: 'createdDate', direction: prev.key === 'createdDate' && prev.direction === 'asc' ? 'desc' : 'asc' }))}
                                    >
                                        <div className="flex items-center gap-1">
                                            Soru Tarihi / Saati
                                            {sortConfig.key === 'createdDate' ? (sortConfig.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-30" />}
                                        </div>
                                    </th>
                                    <th className="px-4 py-3 text-xs font-bold text-gray-600 uppercase tracking-wider text-right">İşlem</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {paginatedQuestions.map((q) => (
                                    <tr key={q.id} className={`hover:bg-gray-50 transition-colors group ${selectedQuestionIds.has(q.id) ? 'bg-blue-50' : ''}`}>
                                        <td className="px-4 py-4">
                                            <input
                                                type="checkbox"
                                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                checked={selectedQuestionIds.has(q.id)}
                                                onChange={() => toggleSelectQuestion(q.id)}
                                            />
                                        </td>
                                        <td className="px-4 py-4 whitespace-nowrap">
                                            <div className="flex flex-col">
                                                <span className="font-bold text-gray-700">{q.storeName}</span>
                                                <span className="text-xs text-gray-500">{q.userName}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-4">
                                            <div className="flex items-center space-x-3">
                                                <div className="flex gap-2">
                                                    {q.productImageUrl && (
                                                        <div className="relative group">
                                                            <img src={q.productImageUrl} alt="" className="w-12 h-12 object-cover rounded border bg-white shadow-sm" />
                                                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded">
                                                                <span className="text-[8px] text-white font-bold">Ürün</span>
                                                            </div>
                                                        </div>
                                                    )}
                                                    {q.questionImageUrl && (
                                                        <div className="relative group">
                                                            <img src={q.questionImageUrl} alt="" className="w-12 h-12 object-cover rounded border border-orange-200 bg-white shadow-sm" />
                                                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded">
                                                                <span className="text-[8px] text-white font-bold">Soru</span>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className="text-xs font-medium text-gray-800 line-clamp-1">{q.productName}</span>
                                                    {q.productUrl && (
                                                        <a href={q.productUrl} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline flex items-center">
                                                            Görüntüle <ExternalLink size={8} className="ml-1" />
                                                        </a>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-4">
                                            <p className="text-sm text-gray-700 line-clamp-3 italic">"{q.text}"</p>
                                            {q.answer && (
                                                <div className="mt-2 bg-blue-50 p-2 rounded-md border border-blue-100">
                                                    <p className="text-xs text-blue-800 font-medium">Cevap:</p>
                                                    <p className="text-xs text-gray-600">{q.answer}</p>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 whitespace-nowrap text-xs text-gray-500">
                                            {safeFormatDate(q.createdDate)}
                                        </td>
                                        <td className="px-4 py-4 whitespace-nowrap text-right">
                                            {q.status === QuestionStatus.WAITING_FOR_ANSWER ? (
                                                <button
                                                    onClick={() => setSelectedQuestion(q)}
                                                    className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-xs font-bold hover:bg-blue-700 transition-colors shadow-sm"
                                                >
                                                    Cevapla
                                                </button>
                                            ) : (
                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                                    Cevaplandı
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {paginatedQuestions.length === 0 && (
                            <div className="flex flex-col items-center justify-center py-20 bg-white rounded-lg border border-dashed text-gray-400">
                                <MessageSquare size={48} className="mb-4 opacity-20" />
                                <p className="text-lg font-medium">Soru bulunamadı</p>
                                <p className="text-sm">Seçili kriterlere uygun soru mevcut değil.</p>
                            </div>
                        )}
                    </div>

                    {/* Pagination Component */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between bg-white px-4 py-3 border-t">
                            <div className="text-xs text-gray-500">
                                Toplam <strong>{filteredQuestions.length}</strong> sorudan <strong>{(currentPage - 1) * itemsPerPage + 1}-{Math.min(currentPage * itemsPerPage, filteredQuestions.length)}</strong> arası gösteriliyor
                            </div>
                            <div className="flex items-center space-x-2">
                                <button
                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                    disabled={currentPage === 1}
                                    className="p-1 rounded border hover:bg-gray-100 disabled:opacity-50"
                                >
                                    <ChevronLeft size={18} />
                                </button>
                                <div className="flex items-center space-x-1">
                                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                                        <button
                                            key={p}
                                            onClick={() => setCurrentPage(p)}
                                            className={`w-8 h-8 rounded text-xs transition-colors ${currentPage === p ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 border'}`}
                                        >
                                            {p}
                                        </button>
                                    ))}
                                </div>
                                <button
                                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                    disabled={currentPage === totalPages}
                                    className="p-1 rounded border hover:bg-gray-100 disabled:opacity-50"
                                >
                                    <ChevronRight size={18} />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Answer Modal */}
                    {selectedQuestion && (
                        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
                            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
                                <div className="bg-gradient-to-r from-blue-600 to-blue-700 p-4 text-white flex justify-between items-center">
                                    <div className="flex items-center space-x-3">
                                        <div className="bg-white/20 p-2 rounded-lg"><MessageSquare size={20} /></div>
                                        <div>
                                            <h3 className="font-bold text-lg">Müşteri Sorusuna Cevap Ver</h3>
                                            <p className="text-xs text-blue-100">{selectedQuestion.storeName} - {selectedQuestion.marketplaceQuestionId}</p>
                                        </div>
                                    </div>
                                    <button onClick={() => setSelectedQuestion(null)} className="p-1 hover:bg-white/20 rounded-full transition-colors">
                                        <Plus size={24} className="rotate-45" />
                                    </button>
                                </div>

                                <div className="p-6 space-y-6 overflow-y-auto max-h-[80vh]">
                                    <div className="bg-gray-50 rounded-2xl p-5 border-2 border-dashed border-gray-200 shadow-inner">
                                        <div className="flex flex-col md:flex-row gap-6">
                                            <div className="flex gap-3 justify-center md:justify-start">
                                                {selectedQuestion.productImageUrl && (
                                                    <div className="relative group shrink-0">
                                                        <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-cyan-500 rounded-2xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
                                                        <img
                                                            src={selectedQuestion.productImageUrl}
                                                            alt=""
                                                            className="relative w-40 h-40 object-cover rounded-2xl border-4 border-white shadow-xl bg-white cursor-zoom-in hover:scale-105 transition-transform duration-300"
                                                            onClick={() => window.open(selectedQuestion.productImageUrl, '_blank')}
                                                        />
                                                        <div className="absolute top-2 left-2 bg-blue-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg">ÜRÜN</div>
                                                    </div>
                                                )}
                                                {selectedQuestion.questionImageUrl && (
                                                    <div className="relative group shrink-0">
                                                        <div className="absolute -inset-1 bg-gradient-to-r from-orange-600 to-yellow-500 rounded-2xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
                                                        <img
                                                            src={selectedQuestion.questionImageUrl}
                                                            alt=""
                                                            className="relative w-40 h-40 object-cover rounded-2xl border-4 border-white shadow-xl bg-white cursor-zoom-in hover:scale-105 transition-transform duration-300"
                                                            onClick={() => window.open(selectedQuestion.questionImageUrl, '_blank')}
                                                        />
                                                        <div className="absolute top-2 left-2 bg-orange-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg">SORU GÖRSELİ</div>
                                                    </div>
                                                )}
                                                {!selectedQuestion.productImageUrl && !selectedQuestion.questionImageUrl && (
                                                    <div className="w-40 h-40 bg-gray-200 rounded-2xl flex flex-col items-center justify-center text-gray-400 border-2 border-dashed">
                                                        <ImageIcon size={40} className="mb-2 opacity-20" />
                                                        <span className="text-[10px] font-bold">Görsel Yok</span>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex-1 flex flex-col justify-center">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className="bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider">
                                                        {selectedQuestion.storeName}
                                                    </span>
                                                    <span className="text-[10px] text-gray-400 font-mono">#{selectedQuestion.marketplaceQuestionId}</span>
                                                </div>
                                                <div className="flex items-start justify-between gap-3 mb-1">
                                                    <h4 className="text-base font-extrabold text-gray-900 leading-tight">{selectedQuestion.productName}</h4>
                                                    <button
                                                            onClick={() => openProductLink(selectedQuestion.productUrl)}
                                                            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-blue-200 text-blue-700 text-xs font-extrabold hover:bg-blue-50 transition-colors shadow-sm"
                                                            title="Ürün sayfasını tarayıcıda aç"
                                                        >
                                                            <ExternalLink size={14} />
                                                            Ürüne Git
                                                        </button>
                                                </div>
                                                <div className="flex items-center gap-3 mb-4">
                                                    <div className="flex items-center gap-1.5">
                                                        <div className="w-6 h-6 bg-gradient-to-tr from-gray-200 to-gray-300 rounded-full flex items-center justify-center text-[10px] font-bold text-gray-600">
                                                            {selectedQuestion.userName.charAt(0)}
                                                        </div>
                                                        <span className="text-sm font-bold text-gray-700">{selectedQuestion.userName}</span>
                                                    </div>
                                                    <span className="text-gray-300">|</span>
                                                    <span className="text-xs text-gray-500 flex items-center"><Clock size={12} className="mr-1" /> {safeFormatDate(selectedQuestion.createdDate)}</span>
                                                </div>
                                                <div className="relative bg-white p-4 rounded-xl border border-gray-200 shadow-sm italic text-gray-800 text-sm before:content-['“'] before:text-4xl before:text-blue-100 before:absolute before:-top-2 before:left-2 after:content-['”'] after:text-4xl after:text-blue-100 after:absolute after:-bottom-6 after:right-2 overflow-hidden">
                                                    {selectedQuestion.text}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-bold text-gray-700 mb-2 flex justify-between">
                                            Cevabınız
                                            <span className={`text-xs ${answerText.length >= 10 && answerText.length <= 2000 ? 'text-green-600' : 'text-red-500'}`}>
                                                {answerText.length} / 2000
                                            </span>
                                        </label>
                                        <textarea
                                            className="w-full border-2 border-gray-200 rounded-xl p-4 text-sm focus:border-blue-500 focus:ring-0 outline-none transition-colors h-40 resize-none"
                                            placeholder="Cevabınızı buraya yazın..."
                                            value={answerText}
                                            onChange={(e) => setAnswerText(e.target.value)}
                                        />
                                    </div>

                                    {db.settings.quickAnswers && db.settings.quickAnswers.length > 0 && (
                                        <div>
                                            <p className="text-xs font-bold text-gray-500 mb-2 uppercase tracking-wider">Hazır Cevaplar</p>
                                            <div className="flex flex-wrap gap-2">
                                                {db.settings.quickAnswers.map((qa) => (
                                                    <button
                                                        key={qa.id}
                                                        onClick={() => useQuickAnswer(qa.text)}
                                                        className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-xs font-medium transition-colors border"
                                                    >
                                                        {qa.title}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="p-4 bg-gray-50 border-t flex justify-between items-center">
                                    <div className="flex space-x-2">
                                        <button
                                            onClick={handlePrevious}
                                            disabled={filteredQuestions.findIndex(q => q.id === selectedQuestion.id) <= 0}
                                            className="px-4 py-2 text-sm font-bold text-gray-700 bg-white border border-gray-300 rounded-xl hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed flex items-center"
                                        >
                                            <ChevronLeft size={18} className="mr-1" /> Önceki
                                        </button>
                                        <button
                                            onClick={handleNext}
                                            disabled={filteredQuestions.findIndex(q => q.id === selectedQuestion.id) >= filteredQuestions.length - 1}
                                            className="px-4 py-2 text-sm font-bold text-gray-700 bg-white border border-gray-300 rounded-xl hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed flex items-center"
                                        >
                                            Sonraki <ChevronRight size={18} className="ml-1" />
                                        </button>
                                    </div>
                                    <div className="flex space-x-3">
                                        <button onClick={() => setSelectedQuestion(null)} className="px-6 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded-xl transition-colors">Vazgeç</button>
                                        <button
                                            onClick={handleAnswer}
                                            disabled={isAnswering || answerText.length < 10 || answerText.length > 2000}
                                            className="px-8 py-2 text-sm font-bold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center shadow-lg transition-all active:scale-95"
                                        >
                                            {isAnswering ? <><Clock className="w-4 h-4 mr-2 animate-spin" /> Gönderiliyor...</> : <><Send className="w-4 h-4 mr-2" /> Cevabı Gönder</>}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {notification && (
                        <div className={`fixed bottom-4 right-4 p-4 rounded-xl shadow-xl z-50 animate-in slide-in-from-right duration-300 ${notification.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
                            <div className="flex items-center space-x-2">
                                {notification.type === 'success' ? <CheckCircle size={20} /> : <AlertTriangle size={20} />}
                                <span className="text-sm font-bold">{notification.message}</span>
                            </div>
                        </div>
                    )}

                    {/* Bulk Answer Modal */}
                    {isBulkModalOpen && (
                        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4 backdrop-blur-sm">
                            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in duration-200 border-4 border-orange-50 underline-offset-4">
                                <div className="bg-gradient-to-r from-orange-600 to-red-600 p-6 text-white flex justify-between items-center">
                                    <div className="flex items-center space-x-3">
                                        <div className="bg-white/20 p-2 rounded-xl"><Send size={24} /></div>
                                        <div>
                                            <h3 className="font-extrabold text-xl">Toplu Cevapla</h3>
                                            <p className="text-xs text-orange-100 font-bold">{selectedQuestionIds.size} adet soru seçildi</p>
                                        </div>
                                    </div>
                                    <button onClick={() => setIsBulkModalOpen(false)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
                                        <Plus size={24} className="rotate-45" />
                                    </button>
                                </div>

                                <div className="p-8 space-y-6 bg-gray-50/50">
                                    <div className="bg-yellow-50 border-2 border-dashed border-yellow-200 p-4 rounded-xl">
                                        <p className="text-xs text-yellow-800 font-bold flex items-center">
                                            <AlertTriangle size={16} className="mr-2" /> DİKKAT: Aynı cevap seçilen tüm sorulara gönderilecektir.
                                        </p>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-extrabold text-gray-700 mb-2 uppercase tracking-tight">Ortak Cevap Metni</label>
                                        <textarea
                                            className="w-full border-2 border-gray-100 focus:border-orange-500 rounded-2xl p-4 text-sm outline-none transition-all h-48 resize-none shadow-sm font-medium"
                                            placeholder="Tüm seçili sorular için cevabı buraya yazın..."
                                            value={bulkAnswerText}
                                            onChange={(e) => setBulkAnswerText(e.target.value)}
                                        />
                                    </div>

                                    {db.settings.quickAnswers && db.settings.quickAnswers.length > 0 && (
                                        <div>
                                            <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-widest">Hazır Cevaplar</p>
                                            <div className="flex flex-wrap gap-2">
                                                {db.settings.quickAnswers.map((qa) => (
                                                    <button
                                                        key={qa.id}
                                                        onClick={() => setBulkAnswerText(qa.text)}
                                                        className="px-4 py-2 bg-white hover:bg-gray-50 text-gray-700 rounded-xl text-xs font-bold transition-all border-2 border-gray-100 hover:border-orange-500 shadow-sm"
                                                    >
                                                        {qa.title}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="p-6 bg-white border-t flex gap-4">
                                    <button
                                        onClick={() => setIsBulkModalOpen(false)}
                                        className="flex-1 px-6 py-4 rounded-2xl border-2 border-gray-100 text-gray-600 font-extrabold text-sm hover:bg-gray-50 transition-all uppercase tracking-widest"
                                    >
                                        İptal
                                    </button>
                                    <button
                                        onClick={handleBulkAnswer}
                                        disabled={isBulkAnswering || !bulkAnswerText.trim()}
                                        className="flex-[2] px-6 py-4 rounded-2xl bg-gradient-to-br from-orange-600 to-red-600 text-white font-extrabold text-sm hover:shadow-xl hover:shadow-orange-200 disabled:opacity-50 transition-all flex items-center justify-center uppercase tracking-widest"
                                    >
                                        {isBulkAnswering ? (
                                            <>
                                                <RotateCw size={20} className="mr-2 animate-spin" /> Cevaplanıyor...
                                            </>
                                        ) : (
                                            <>
                                                <CheckCircle size={20} className="mr-2" /> Toplu Gönder
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}

            {activeTab === 'quick-answers' && (
                <div className="flex-1 overflow-auto px-4 pb-4 animate-in fade-in duration-300">
                    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                        <div className="bg-gray-50 p-6 border-b flex justify-between items-center">
                            <div>
                                <h3 className="text-lg font-extrabold text-gray-800">Hazır Cevap Yönetimi</h3>
                                <p className="text-xs text-gray-500 font-medium italic">Sık kullanılan cevapları buradan oluşturabilir ve düzenleyebilirsiniz.</p>
                            </div>
                            <button
                                onClick={() => {
                                    setQaForm({ id: '', title: '', text: '' });
                                    setIsQAModalOpen(true);
                                }}
                                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-all active:scale-95"
                            >
                                <Plus size={18} /> Yeni Hazır Cevap
                            </button>
                        </div>

                        <div className="p-6">
                            {db.settings.quickAnswers && db.settings.quickAnswers.length > 0 ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {db.settings.quickAnswers.map((qa) => (
                                        <div key={qa.id} className="group border-2 border-gray-100 rounded-3xl p-5 hover:border-blue-200 hover:bg-blue-50/30 transition-all flex flex-col h-full relative overflow-hidden bg-white shadow-sm hover:shadow-md">
                                            <div className="flex justify-between items-start mb-4">
                                                <h4 className="font-extrabold text-gray-800 text-sm group-hover:text-blue-700 transition-colors uppercase tracking-tight">{qa.title}</h4>
                                                <div className="flex gap-1.5 ">
                                                    <button
                                                        onClick={() => {
                                                            setQaForm(qa);
                                                            setIsQAModalOpen(true);
                                                        }}
                                                        className="p-2 text-blue-600 hover:bg-blue-100 rounded-xl transition-colors"
                                                        title="Düzenle"
                                                    >
                                                        <Edit size={16} />
                                                    </button>
                                                    <button
                                                        onClick={() => {
                                                            setDeleteConfirmId(qa.id);
                                                        }}
                                                        className="p-2 text-red-600 hover:bg-red-100 rounded-xl transition-colors"
                                                        title="Sil"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="flex-1 bg-gray-50 p-4 rounded-2xl border border-gray-100">
                                                <p className="text-xs text-gray-600 italic font-medium leading-relaxed">
                                                    "{qa.text}"
                                                </p>
                                            </div>
                                            <div className="mt-4 flex items-center gap-2">
                                                <div className="h-1 flex-1 bg-gray-100 rounded-full overflow-hidden">
                                                    <div className="h-full bg-blue-400 w-1/3 opacity-30"></div>
                                                </div>
                                                <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Hazır Şablon</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center py-24 bg-gray-50 rounded-3xl border-2 border-dashed border-gray-200 group hover:border-blue-300 transition-colors">
                                    <div className="p-6 bg-white rounded-3xl shadow-sm mb-6 group-hover:scale-110 transition-transform">
                                        <MessageSquare size={48} className="text-gray-300 group-hover:text-blue-400 transition-colors" />
                                    </div>
                                    <p className="text-lg font-extrabold text-gray-800">Henüz hazır cevap eklenmemiş</p>
                                    <p className="text-sm text-gray-500 font-medium mb-8">Müşteri sorularına hızlı yanıt vermek için şablonlar oluşturun.</p>
                                    <button
                                        onClick={() => {
                                            setQaForm({ id: '', title: '', text: '' });
                                            setIsQAModalOpen(true);
                                        }}
                                        className="bg-white border-2 border-blue-600 text-blue-600 px-8 py-3 rounded-2xl text-sm font-extrabold hover:bg-blue-50 transition-all flex items-center gap-2 shadow-sm"
                                    >
                                        <Plus size={20} /> İlk Hazır Cevabı Ekle
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Delete Confirmation Modal */}
                    {deleteConfirmId && (
                        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4 backdrop-blur-sm animate-in fade-in duration-200">
                            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in duration-200">
                                <div className="p-6 text-center">
                                    <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <Trash2 size={32} />
                                    </div>
                                    <h3 className="text-lg font-extrabold text-gray-900 mb-2">Hazır Cevabı Sil</h3>
                                    <p className="text-sm text-gray-500 mb-6">
                                        Bu hazır cevabı silmek istediğinize emin misiniz? Bu işlem geri alınamaz.
                                    </p>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => setDeleteConfirmId(null)}
                                            className="flex-1 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl text-sm font-bold transition-all"
                                        >
                                            Vazgeç
                                        </button>
                                        <button
                                            onClick={() => {
                                                onUpdateDB(prev => ({
                                                    ...prev,
                                                    settings: {
                                                        ...prev.settings,
                                                        quickAnswers: (prev.settings.quickAnswers || []).filter(a => a.id !== deleteConfirmId)
                                                    }
                                                }));
                                                setDeleteConfirmId(null);
                                                setNotification({ type: 'success', message: 'Hazır cevap silindi.' });
                                            }}
                                            className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-bold transition-all shadow-lg shadow-red-100"
                                        >
                                            Evet, Sil
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* QUICK ANSWER EDIT MODAL */}
            {isQAModalOpen && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[10000] p-4 animate-in fade-in duration-300">
                    <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden flex flex-col border border-gray-100">
                        <div className="p-6 border-b flex justify-between items-center bg-gray-50/50">
                            <div>
                                <h3 className="text-lg font-extrabold text-gray-800 flex items-center gap-2">
                                    <Clock className="text-blue-600" size={20} />
                                    {qaForm.id ? 'Hazır Cevap Düzenle' : 'Yeni Hazır Cevap'}
                                </h3>
                                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mt-0.5">Hızlı Şablon Oluşturucu</p>
                            </div>
                            <button onClick={() => setIsQAModalOpen(false)} className="p-2 hover:bg-gray-200 rounded-xl transition-colors"><X size={20} /></button>
                        </div>

                        <div className="p-8 space-y-6">
                            <div className="space-y-2">
                                <label className="text-[10px] font-extrabold text-gray-400 uppercase tracking-[0.2em] px-1">Şablon Başlığı</label>
                                <input
                                    className="w-full px-5 py-4 bg-gray-50 border-2 border-gray-100 rounded-2xl focus:border-blue-500 focus:bg-white outline-none transition-all text-sm font-bold placeholder:text-gray-300"
                                    placeholder="Örn: Kargo Bilgisi"
                                    value={qaForm.title}
                                    onChange={e => setQaForm({ ...qaForm, title: e.target.value })}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-extrabold text-gray-400 uppercase tracking-[0.2em] px-1">Cevap İçeriği</label>
                                <textarea
                                    className="w-full h-40 px-5 py-4 bg-gray-50 border-2 border-gray-100 rounded-2xl focus:border-blue-500 focus:bg-white outline-none transition-all text-sm font-medium leading-relaxed resize-none placeholder:text-gray-300"
                                    placeholder="Müşteriye gönderilecek standart mesaj..."
                                    value={qaForm.text}
                                    onChange={e => setQaForm({ ...qaForm, text: e.target.value })}
                                />
                            </div>
                        </div>

                        <div className="p-8 border-t bg-gray-50/50 flex justify-end gap-4">
                            <button
                                onClick={() => setIsQAModalOpen(false)}
                                className="px-6 py-3 text-sm font-extrabold text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-2xl transition-all"
                            >
                                İPTAL
                            </button>
                            <button
                                onClick={() => {
                                    if (!qaForm.title || !qaForm.text) return alert("Lütfen tüm alanları doldurun.");
                                    onUpdateDB(prev => {
                                        const currentQAs = prev.settings.quickAnswers || [];
                                        let newQAs;
                                        if (qaForm.id) {
                                            newQAs = currentQAs.map(item => item.id === qaForm.id ? { ...qaForm } : item);
                                        } else {
                                            newQAs = [...currentQAs, { ...qaForm, id: uuidv4() }];
                                        }
                                        return { ...prev, settings: { ...prev.settings, quickAnswers: newQAs } };
                                    });
                                    setIsQAModalOpen(false);
                                }}
                                className="px-10 py-3 bg-blue-600 text-white rounded-2xl text-sm font-extrabold hover:bg-blue-700 transition-all shadow-xl shadow-blue-200 active:scale-95 flex items-center gap-2"
                            >
                                <Save size={18} />
                                {qaForm.id ? 'GÜNCELLE' : 'KAYDET'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
