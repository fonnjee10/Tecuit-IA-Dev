/**
 * Tecuit IA - Chat Manager
 * Gestionnaire de conversation pour les modèles Hermes 7B Q4/Q8
 * Compatible avec les API ngrok -> localhost:1234
 */

// ==================== CONFIGURATION ====================
const ChatConfig = {
  // Modèles disponibles
  models: {
    'hermes-7b-q4': {
      id: 'hermes-7b-q4',
      name: 'Hermes 7B Q4',
      modelName: 'izhanjafry/nous-hermes-2-mistral-7b-dpo',
      apiUrl: 'https://tecuit-ai-nc.ngrok.dev',
      localUrl: 'http://localhost:1234',
      quantization: 'Q4',
      description: 'Rapide - Idéal pour les tâches quotidiennes',
      maxTokens: 2048,
      temperature: 0.7
    },
    'hermes-7b-q8': {
      id: 'hermes-7b-q8',
      name: 'Hermes 7B Q8',
      modelName: 'nousresearch/nous-hermes-2-mistral-7b-dpo',
      apiUrl: 'https://zenkaritecuitai.ngrok.app',
      localUrl: 'http://localhost:1234',
      quantization: 'Q8',
      description: 'Puissant - Meilleur pour le raisonnement complexe',
      maxTokens: 4096,
      temperature: 0.5
    }
  },
  
  // Endpoint API
  endpoint: '/v1/chat/completions',
  
  // Clé de chiffrement AES-256 pour les données locales
  encryptionKey: 'TecuitIA-SecretKey-2024-AES256',
  
  // Limites
  maxFileSize: 50 * 1024 * 1024, // 50MB
  maxHistoryLength: 100, // Nombre max de messages dans l'historique
  
  // Timeouts
  requestTimeout: 120000, // 2 minutes
  retryDelay: 2000
};

// ==================== ÉTAT GLOBAL ====================
const ChatState = {
  currentModel: 'hermes-7b-q4',
  currentApiUrl: null,
  conversationHistory: [],
  abortController: null,
  isGenerating: false,
  pendingFileContent: null,
  callbacks: {
    onMessage: null,
    onStatus: null,
    onError: null,
    onModelChange: null
  }
};

// ==================== CLASSE PRINCIPALE ====================
class TecuitChat {
  
  constructor(config = {}) {
    this.config = { ...ChatConfig, ...config };
    this.state = { ...ChatState };
    this._initApiUrl();
  }
  
  // Initialisation de l'URL API selon le modèle
  _initApiUrl() {
    const model = this.config.models[this.state.currentModel];
    // Priorité: URL locale si disponible, sinon URL ngrok
    this.state.currentApiUrl = this._isLocalhost() ? model.localUrl : model.apiUrl;
  }
  
  // Détection environnement local
  _isLocalhost() {
    return window.location.hostname === 'localhost' || 
           window.location.hostname === '127.0.0.1';
  }
  
  // ==================== GESTION DES MODÈLES ====================
  
  /**
   * Change le modèle IA actif
   * @param {string} modelId - 'hermes-7b-q4' ou 'hermes-7b-q8'
   * @returns {boolean} Succès du changement
   */
  setModel(modelId) {
    if (!this.config.models[modelId]) {
      this._triggerError(`Modèle inconnu: ${modelId}`);
      return false;
    }
    
    this.state.currentModel = modelId;
    this._initApiUrl();
    
    // Notification callback
    if (this.state.callbacks.onModelChange) {
      const model = this.config.models[modelId];
      this.state.callbacks.onModelChange({
        id: modelId,
        name: model.name,
        quantization: model.quantization,
        apiUrl: this.state.currentApiUrl
      });
    }
    
    return true;
  }
  
  /**
   * Récupère les informations du modèle actuel
   */
  getCurrentModel() {
    const model = this.config.models[this.state.currentModel];
    return {
      ...model,
      activeApiUrl: this.state.currentApiUrl
    };
  }
  
  /**
   * Liste tous les modèles disponibles
   */
  getAvailableModels() {
    return Object.values(this.config.models).map(m => ({
      id: m.id,
      name: m.name,
      quantization: m.quantization,
      description: m.description,
      isActive: m.id === this.state.currentModel
    }));
  }
  
  // ==================== ENVOI DE MESSAGE ====================
  
  /**
   * Envoie un message à l'IA avec streaming
   * @param {string} message - Contenu du message
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<void>}
   */
  async sendMessage(message, options = {}) {
    if (this.state.isGenerating) {
      this._triggerError('Génération en cours, veuillez attendre');
      return;
    }
    
    if (!message?.trim() && !this.state.pendingFileContent) {
      return;
    }
    
    // Préparation du message
    const fullMessage = this._prepareMessage(message);
    
    // Ajout à l'historique utilisateur
    this._addToHistory('user', message);
    this._triggerMessage('user', message);
    
    // État de génération
    this.state.isGenerating = true;
    this.state.abortController = new AbortController();
    const { signal } = this.state.abortController;
    
    // Timeout de sécurité
    const timeoutId = setTimeout(() => {
      if (this.state.abortController) {
        this.state.abortController.abort();
      }
    }, this.config.requestTimeout);
    
    try {
      const model = this.config.models[this.state.currentModel];
      
      const response = await fetch(`${this.state.currentApiUrl}${this.config.endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          model: model.modelName,
          messages: this._formatHistoryForAPI(),
          stream: true,
          temperature: options.temperature ?? model.temperature,
          max_tokens: options.maxTokens ?? model.maxTokens,
          top_p: 0.95,
          frequency_penalty: 0,
          presence_penalty: 0
        }),
        signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Erreur inconnue');
        throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
      }
      
      // Gestion du streaming
      await this._handleStreaming(response);
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        this._triggerMessage('assistant', '\n*[Génération arrêtée par l utilisateur]*');
      } else {
        console.error('[Chat Error]', error);
        this._triggerError(`Erreur de connexion: ${error.message}`);
        this._triggerMessage('assistant', `❌ **Erreur de connexion**\n\n${error.message}\n\n*Vérifiez que le backend est accessible sur ${this.state.currentApiUrl}*`);
      }
    } finally {
      this.state.isGenerating = false;
      this.state.abortController = null;
      this.state.pendingFileContent = null;
    }
  }
  
  // Préparation du message avec contenu de fichier si présent
  _prepareMessage(message) {
    if (!this.state.pendingFileContent) return message;
    
    const file = this.state.pendingFileContent;
    return `${message}\n\n--- CONTENU DU FICHIER ---\nNom: ${file.filename}\nType: ${file.type}\nTaille: ${file.size}\n\n${file.content}`;
  }
  
  // Formatage de l'historique pour l'API
  _formatHistoryForAPI() {
    return this.state.conversationHistory
      .slice(-this.config.maxHistoryLength)
      .filter(msg => ['user', 'assistant'].includes(msg.role))
      .map(msg => ({
        role: msg.role,
        content: msg.content
      }));
  }
  
  // Gestion du streaming SSE
  async _handleStreaming(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullReply = '';
    let messageId = null;
    
    // Message initial vide pour l'IA
    messageId = this._triggerMessage('assistant', '', true);
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (!line.includes('data:')) continue;
        
        const dataStr = line.replace('data:', '').trim();
        if (dataStr === '[DONE]' || !dataStr) continue;
        
        try {
          const json = JSON.parse(dataStr);
          const content = json.choices?.[0]?.delta?.content || '';
          
          if (content) {
            fullReply += content;
            this._updateMessage(messageId, fullReply);
          }
        } catch (e) {
          // Ignorer les erreurs de parsing partiel
          console.debug('Parse stream error:', e);
        }
      }
    }
    
    // Sauvegarde finale
    if (fullReply.trim()) {
      this._addToHistory('assistant', fullReply);
    }
  }
  
  // ==================== GESTION DE L'HISTORIQUE ====================
  
  /**
   * Ajoute un message à l'historique local
   */
  _addToHistory(role, content) {
    this.state.conversationHistory.push({
      role: role === 'tecuit' ? 'assistant' : role,
      content,
      timestamp: Date.now()
    });
    
    // Nettoyage si trop long
    if (this.state.conversationHistory.length > this.config.maxHistoryLength) {
      this.state.conversationHistory = 
        this.state.conversationHistory.slice(-this.config.maxHistoryLength);
    }
  }
  
  /**
   * Récupère l'historique de conversation
   */
  getHistory() {
    return [...this.state.conversationHistory];
  }
  
  /**
   * Efface l'historique de conversation
   */
  clearHistory() {
    this.state.conversationHistory = [];
    if (this.state.callbacks.onStatus) {
      this.state.callbacks.onStatus('history_cleared');
    }
  }
  
  /**
   * Exporte la conversation en JSON chiffré
   */
  exportConversation() {
    const exportData = {
      model: this.state.currentModel,
      exportedAt: new Date().toISOString(),
      messages: this.state.conversationHistory,
      encrypted: true,
      data: this._encryptData(this.state.conversationHistory)
    };
    
    return JSON.stringify(exportData, null, 2);
  }
  
  // ==================== CONTRÔLE DE GÉNÉRATION ====================
  
  /**
   * Arrête la génération en cours
   */
  stopGeneration() {
    if (this.state.abortController) {
      this.state.abortController.abort();
      this.state.abortController = null;
      this.state.isGenerating = false;
      return true;
    }
    return false;
  }
  
  /**
   * Vérifie si une génération est en cours
   */
  isGenerating() {
    return this.state.isGenerating;
  }
  
  // ==================== GESTION DES FICHIERS ====================
  
  /**
   * Attache un contenu de fichier au prochain message
   */
  attachFileContent(filename, type, size, content) {
    this.state.pendingFileContent = {
      filename,
      type,
      size: this._formatBytes(size),
      content
    };
  }
  
  /**
   * Traite un fichier image avec OCR (nécessite Tesseract.js)
   */
  async processImageWithOCR(file, lang = 'eng') {
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract.js non chargé');
    }
    
    if (file.size > this.config.maxFileSize) {
      throw new Error('Fichier trop volumineux');
    }
    
    const worker = await Tesseract.createWorker(lang);
    await worker.load();
    await worker.loadLanguage(lang);
    await worker.initialize(lang);
    
    const { data: { text } } = await worker.recognize(file);
    await worker.terminate();
    
    return text;
  }
  
  /**
   * Lit un fichier texte
   */
  readTextFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Erreur de lecture'));
      reader.readAsText(file);
    });
  }
  
  // ==================== CALLBACKS ====================
  
  /**
   * Configure les callbacks d'événements
   */
  on(event, callback) {
    if (this.state.callbacks.hasOwnProperty(event)) {
      this.state.callbacks[event] = callback;
    }
    return this;
  }
  
  // Déclenchement des callbacks
  _triggerMessage(role, content, isNew = false) {
    if (this.state.callbacks.onMessage) {
      return this.state.callbacks.onMessage({ role, content, isNew });
    }
    return null;
  }
  
  _updateMessage(messageId, content) {
    if (this.state.callbacks.onMessage) {
      this.state.callbacks.onMessage({ 
        role: 'assistant', 
        content, 
        isNew: false,
        messageId 
      });
    }
  }
  
  _triggerError(message) {
    if (this.state.callbacks.onError) {
      this.state.callbacks.onError(message);
    }
    console.error('[TecuitChat]', message);
  }
  
  _triggerStatus(status, data = null) {
    if (this.state.callbacks.onStatus) {
      this.state.callbacks.onStatus(status, data);
    }
  }
  
  // ==================== UTILITAIRES ====================
  
  /**
   * Chiffrement AES-256 des données locales
   */
  _encryptData(data) {
    if (typeof CryptoJS === 'undefined') {
      console.warn('CryptoJS non disponible, données non chiffrées');
      return JSON.stringify(data);
    }
    
    try {
      const jsonString = JSON.stringify(data);
      return CryptoJS.AES.encrypt(jsonString, this.config.encryptionKey).toString();
    } catch (e) {
      console.error('[Encryption Error]', e);
      return null;
    }
  }
  
  /**
   * Déchiffrement AES-256
   */
  _decryptData(encryptedData) {
    if (typeof CryptoJS === 'undefined') {
      return JSON.parse(encryptedData);
    }
    
    try {
      const bytes = CryptoJS.AES.decrypt(encryptedData, this.config.encryptionKey);
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);
      return decrypted ? JSON.parse(decrypted) : null;
    } catch (e) {
      console.error('[Decryption Error]', e);
      return null;
    }
  }
  
  /**
   * Formatage de la taille en octets
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  /**
   * Formatage basique du markdown
   */
  formatMessage(text) {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
  
  // ==================== PERSISTENCE ====================
  
  /**
   * Sauvegarde l'état dans localStorage
   */
  saveState(storageKey = 'tecuit_chat_state') {
    const state = {
      model: this.state.currentModel,
      history: this.state.conversationHistory,
      timestamp: Date.now()
    };
    
    try {
      const encrypted = this._encryptData(state);
      localStorage.setItem(storageKey, encrypted);
      return true;
    } catch (e) {
      console.error('[Save Error]', e);
      return false;
    }
  }
  
  /**
   * Charge l'état depuis localStorage
   */
  loadState(storageKey = 'tecuit_chat_state') {
    try {
      const encrypted = localStorage.getItem(storageKey);
      if (!encrypted) return false;
      
      const state = this._decryptData(encrypted);
      if (!state) return false;
      
      if (state.model && this.config.models[state.model]) {
        this.setModel(state.model);
      }
      
      if (Array.isArray(state.history)) {
        this.state.conversationHistory = state.history;
      }
      
      return true;
    } catch (e) {
      console.error('[Load Error]', e);
      return false;
    }
  }
  
  /**
   * Réinitialise complètement le chat
   */
  reset() {
    this.stopGeneration();
    this.clearHistory();
    this.state.pendingFileContent = null;
    this._initApiUrl();
  }
}

// ==================== EXPORTS ====================

// Export pour navigateur
if (typeof window !== 'undefined') {
  window.TecuitChat = TecuitChat;
  window.ChatConfig = ChatConfig;
}

// Export pour Node.js / modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TecuitChat, ChatConfig };
}

// ==================== INITIALISATION RAPIDE ====================

/**
 * Fonction utilitaire pour initialiser rapidement le chat
 */
window.initTecuitChat = function(options = {}) {
  const chat = new TecuitChat(options);
  
  // Configuration par défaut des callbacks UI
  chat
    .on('onMessage', (msg) => {
      // À implémenter selon votre UI
      console.log('Message:', msg);
    })
    .on('onError', (err) => {
      alert('Erreur: ' + err);
    })
    .on('onStatus', (status) => {
      console.log('Status:', status);
    })
    .on('onModelChange', (model) => {
      console.log('Modèle changé:', model.name);
    });
  
  // Chargement automatique de l'état
  chat.loadState();
  
  return chat;
};

// Auto-initialisation si élément HTML présent
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('tecuit-chat-container')) {
    window.tecuitChat = window.initTecuitChat();
  }
});
