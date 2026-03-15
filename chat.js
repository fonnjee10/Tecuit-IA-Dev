/**
 * ============================================================================
 * TECUIT IA - CHAT MANAGER v2.1.0
 * Gestionnaire de conversation pour Hermes 7B Q4/Q8
 * Compatible avec API ngrok -> localhost:1234
 * ============================================================================
 */

// ==================== CONFIGURATION GLOBALE ====================
const TecuitConfig = {
  // Endpoints API
  API_ENDPOINT: '/v1/chat/completions',
  
  // Modèles disponibles avec leurs configurations
  MODELS: {
    'Hermes 7B Q4': {
      id: 'hermes-7b-q4',
      name: 'Hermes 7B Q4',
      modelName: 'nous-hermes-2-mistral-7b-dpo',
      apiUrl: 'https://tecuit-ai-nc.ngrok.dev',
      localUrl: 'http://localhost:1234',
      quantization: 'Q4',
      description: 'Rapide - Idéal pour les tâches quotidiennes',
      maxTokens: 2048,
      temperature: 0.7,
      priority: 1
    },
    'Hermes 7B Q8': {
      id: 'hermes-7b-q8',
      name: 'Hermes 7B Q8', 
      modelName: 'nous-hermes-2-mistral-7b-dpo',
      apiUrl: 'https://zenkaritecuitai.ngrok.app',
      localUrl: 'http://localhost:1034',
      quantization: 'Q8',
      description: 'Puissant - Meilleur pour le raisonnement complexe',
      maxTokens: 4096,
      temperature: 0.5,
      priority: 2
    }
  },
  
  // Clé de chiffrement AES-256 (à personnaliser en production)
  ENCRYPTION_KEY: 'TecuitIA-SecretKey-2024-AES256-Production!',
  
  // Limites et timeouts
  MAX_FILE_SIZE: 50 * 1024 * 1024,      // 50MB
  MAX_HISTORY_LENGTH: 50,                // Messages max dans l'historique
  API_TIMEOUT: 60000,                    // 60 secondes
  RETRY_DELAY: 2000,                     // 2 secondes entre les retries
  
  // Paramètres de génération par défaut
  DEFAULT_PARAMS: {
    stream: true,
    temperature: 0.7,
    max_tokens: 2048,
    top_p: 0.95,
    frequency_penalty: 0,
    presence_penalty: 0
  }
};

// ==================== ÉTAT GLOBAL ====================
const ChatState = {
  // Utilisateur et authentification
  currentUser: null,
  
  // Modèle et API actifs
  currentModel: 'Hermes 7B Q4',
  currentApiUrl: null,
  
  // Conversation
  conversationHistory: [],
  conversations: [],
  currentConversationId: null,
  
  // Génération en cours
  isGenerating: false,
  abortController: null,
  
  // Contenu de fichier en attente
  pendingFileContent: null,
  
  // Statut de connexion API
  apiStatus: 'checking', // 'checking' | 'online' | 'offline'
  
  // Callbacks pour l'interface
  callbacks: {
    onMessage: null,
    onStatus: null,
    onError: null,
    onModelChange: null,
    onConnectionChange: null
  }
};

// ==================== CLASSE PRINCIPALE: TecuitChat ====================
class TecuitChat {
  
  constructor(config = {}) {
    this.config = { ...TecuitConfig, ...config };
    this.state = { ...ChatState };
    this._initialize();
  }
  
  // Initialisation
  _initialize() {
    this._detectEnvironment();
    this._initApiUrl();
    this._loadFromStorage();
    console.log('[TecuitChat] Initialisé avec modèle:', this.state.currentModel);
  }
  
  // Détection environnement (local vs production)
  _detectEnvironment() {
    this.isLocalhost = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' ||
                       window.location.hostname === '0.0.0.0';
  }
  
  // Initialisation de l'URL API selon environnement
  _initApiUrl() {
    const model = this.config.MODELS[this.state.currentModel];
    if (!model) {
      console.error('[TecuitChat] Modèle inconnu:', this.state.currentModel);
      return;
    }
    // Priorité: URL locale si disponible et en localhost, sinon URL ngrok
    this.state.currentApiUrl = this.isLocalhost ? model.localUrl : model.apiUrl;
  }
  
  // ==================== GESTION DES MODÈLES ====================
  
  /**
   * Change le modèle IA actif
   * @param {string} modelId - 'Hermes 7B Q4' ou 'Hermes 7B Q8'
   * @returns {boolean} Succès du changement
   */
  setModel(modelId) {
    if (!this.config.MODELS[modelId]) {
      this._triggerError(`Modèle inconnu: ${modelId}`);
      return false;
    }
    
    const oldModel = this.state.currentModel;
    this.state.currentModel = modelId;
    this._initApiUrl();
    
    console.log(`[TecuitChat] Modèle changé: ${oldModel} → ${modelId}`);
    console.log(`[TecuitChat] API URL: ${this.state.currentApiUrl}`);
    
    // Notification callback
    if (this.state.callbacks.onModelChange) {
      const model = this.config.MODELS[modelId];
      this.state.callbacks.onModelChange({
        id: modelId,
        name: model.name,
        quantization: model.quantization,
        apiUrl: this.state.currentApiUrl,
        oldModel: oldModel
      });
    }
    
    return true;
  }
  
  /**
   * Récupère les informations du modèle actuel
   */
  getCurrentModel() {
    const model = this.config.MODELS[this.state.currentModel];
    return model ? {
      ...model,
      activeApiUrl: this.state.currentApiUrl,
      isLocalhost: this.isLocalhost
    } : null;
  }
  
  /**
   * Liste tous les modèles disponibles
   */
  getAvailableModels() {
    return Object.values(this.config.MODELS).map(m => ({
      id: m.id,
      name: m.name,
      quantization: m.quantization,
      description: m.description,
      isActive: m.name === this.state.currentModel,
      apiUrl: this.isLocalhost ? m.localUrl : m.apiUrl
    }));
  }
  
  // ==================== ENVOI DE MESSAGE ====================
  
  /**
   * Envoie un message à l'IA avec streaming
   * @param {string} message - Contenu du message utilisateur
   * @param {Object} options - Options de génération
   * @returns {Promise<Object>} Résultat de la génération
   */
  async sendMessage(message, options = {}) {
    // Validation
    if (this.state.isGenerating) {
      this._triggerError('Génération en cours, veuillez attendre ou arrêter');
      return { success: false, error: 'GENERATION_IN_PROGRESS' };
    }
    
    const trimmedMessage = message?.trim();
    if (!trimmedMessage && !this.state.pendingFileContent) {
      return { success: false, error: 'EMPTY_MESSAGE' };
    }
    
    // Préparation du message complet
    const fullMessage = this._prepareFullMessage(trimmedMessage);
    
    // Ajout du message utilisateur à l'historique
    this._addToHistory('user', trimmedMessage || '📎 Fichier envoyé');
    this._triggerMessage('user', trimmedMessage || '📎 Fichier envoyé', true);
    
    // État de génération
    this.state.isGenerating = true;
    this.state.abortController = new AbortController();
    const { signal } = this.state.abortController;
    
    try {
      const model = this.config.MODELS[this.state.currentModel];
      if (!model) throw new Error('Modèle non configuré');
      
      // CRITICAL FIX: Construction GARANTIE du tableau messages
      const messagesToSend = this._buildMessagesArray(fullMessage);
      
      // Configuration de la requête
      const requestBody = {
        model: model.modelName,
        messages: messagesToSend,
        stream: true,
        temperature: options.temperature ?? model.temperature,
        max_tokens: options.maxTokens ?? model.maxTokens,
        top_p: this.config.DEFAULT_PARAMS.top_p,
        frequency_penalty: this.config.DEFAULT_PARAMS.frequency_penalty,
        presence_penalty: this.config.DEFAULT_PARAMS.presence_penalty
      };
      
      // Timeout de sécurité
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.API_TIMEOUT);
      
      // Envoi de la requête
      const response = await fetch(`${this.state.currentApiUrl}${this.config.API_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Validation de la réponse
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Erreur inconnue');
        throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 300)}`);
      }
      
      // Gestion du streaming SSE
      const result = await this._handleStreaming(response);
      
      // Sauvegarde de la réponse complète
      if (result.content?.trim()) {
        this._addToHistory('assistant', result.content);
      }
      
      this.state.isGenerating = false;
      this.state.abortController = null;
      this.state.pendingFileContent = null;
      
      return { 
        success: true, 
        content: result.content,
        model: this.state.currentModel,
        tokens: result.usage?.total_tokens
      };
      
    } catch (error) {
      console.error('[TecuitChat] Erreur sendMessage:', error);
      
      // Gestion des erreurs spécifiques
      if (error.name === 'AbortError') {
        this._triggerMessage('assistant', '\n*[Génération arrêtée par l utilisateur]*', false);
        return { success: false, error: 'ABORTED' };
      }
      
      if (error.message.includes('Failed to fetch') || 
          error.message.includes('OPTIONS') ||
          error.message.includes('CORS')) {
        this._triggerError('Erreur CORS: Activez CORS dans LM Studio Server Settings');
        this.state.apiStatus = 'offline';
        this._triggerConnectionChange('offline');
        return { success: false, error: 'CORS_ERROR' };
      }
      
      if (error.message.includes("'messages' field is required")) {
        this._triggerError('Erreur API: Le champ messages est requis - vérifiez la configuration');
        return { success: false, error: 'MISSING_MESSAGES' };
      }
      
      this._triggerError(`Erreur de connexion: ${error.message}`);
      this.state.apiStatus = 'offline';
      this._triggerConnectionChange('offline');
      
      return { success: false, error: 'CONNECTION_ERROR', message: error.message };
      
    } finally {
      this.state.isGenerating = false;
      this.state.abortController = null;
      this.state.pendingFileContent = null;
    }
  }
  
  /**
   * Construction GARANTIE du tableau messages pour l'API
   * FIX CRITIQUE pour l'erreur: 'messages' field is required
   */
  _buildMessagesArray(currentMessage) {
    // Filtrer et formater l'historique
    const historyMessages = this.state.conversationHistory
      .slice(-this.config.MAX_HISTORY_LENGTH)
      .filter(msg => ['user', 'assistant'].includes(msg.role))
      .map(msg => ({
        role: msg.role === 'tecuit' ? 'assistant' : msg.role,
        content: msg.content || ''
      }));
    
    // CRITICAL: Si l'historique est vide, ajouter le message actuel comme premier message
    if (historyMessages.length === 0 && currentMessage) {
      return [{ role: 'user', content: currentMessage }];
    }
    
    // Si on a un nouveau message et qu'il n'est pas déjà dans l'historique
    if (currentMessage) {
      const lastMsg = historyMessages[historyMessages.length - 1];
      if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== currentMessage) {
        historyMessages.push({ role: 'user', content: currentMessage });
      }
    }
    
    // DOUBLE CHECK: Garantir qu'on a au moins un message user
    if (historyMessages.length === 0) {
      return [{ role: 'user', content: 'Bonjour' }];
    }
    
    return historyMessages;
  }
  
  /**
   * Préparation du message avec contenu de fichier si présent
   */
  _prepareFullMessage(message) {
    if (!this.state.pendingFileContent) return message;
    
    const file = this.state.pendingFileContent;
    return `${message}\n\n--- CONTENU DU FICHIER ANALYSÉ ---\n` +
           `Nom: ${file.filename}\n` +
           `Type: ${file.type}\n` +
           `Taille: ${file.size}\n\n` +
           `${file.content}`;
  }
  
  /**
   * Gestion du streaming Server-Sent Events
   */
  async _handleStreaming(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body non lisible');
    
    const decoder = new TextDecoder('utf-8');
    let fullReply = '';
    let messageId = null;
    
    // Message initial vide pour l'IA (pour affichage immédiat)
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
          // Ignorer les erreurs de parsing partiel (normal en streaming)
          console.debug('[Stream Parse]', e.message?.substring(0, 50));
        }
      }
    }
    
    return { content: fullReply };
  }
  
  // ==================== GESTION DE L'HISTORIQUE ====================
  
  /**
   * Ajoute un message à l'historique local
   */
  _addToHistory(role, content) {
    this.state.conversationHistory.push({
      role: role === 'tecuit' ? 'assistant' : role,
      content: content || '',
      timestamp: Date.now(),
      model: this.state.currentModel
    });
    
    // Nettoyage si trop long
    if (this.state.conversationHistory.length > this.config.MAX_HISTORY_LENGTH) {
      this.state.conversationHistory = 
        this.state.conversationHistory.slice(-this.config.MAX_HISTORY_LENGTH);
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
    this._saveToStorage();
    if (this.state.callbacks.onStatus) {
      this.state.callbacks.onStatus('history_cleared');
    }
  }
  
  /**
   * Exporte la conversation en JSON chiffré
   */
  exportConversation() {
    const exportData = {
      version: '2.1.0',
      model: this.state.currentModel,
      exportedAt: new Date().toISOString(),
      messageCount: this.state.conversationHistory.length,
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
      console.log('[TecuitChat] Génération arrêtée');
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
      sizeBytes: size,
      content,
      attachedAt: Date.now()
    };
    console.log(`[TecuitChat] Fichier attaché: ${filename} (${this.state.pendingFileContent.size})`);
  }
  
  /**
   * Traite un fichier image avec OCR (nécessite Tesseract.js)
   */
  async processImageWithOCR(file, lang = 'eng') {
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract.js non chargé - incluez le script CDN');
    }
    
    if (file.size > this.config.MAX_FILE_SIZE) {
      throw new Error(`Fichier trop volumineux: ${this._formatBytes(file.size)} > 50MB`);
    }
    
    console.log('[OCR] Démarrage traitement:', file.name);
    
    const worker = await Tesseract.createWorker(lang);
    await worker.load();
    await worker.loadLanguage(lang);
    await worker.initialize(lang);
    
    const { data: { text, confidence } } = await worker.recognize(file);
    await worker.terminate();
    
    console.log(`[OCR] Terminé: ${text.length} caractères, confiance: ${confidence.toFixed(1)}%`);
    
    return {
      text: text.trim(),
      confidence,
      language: lang
    };
  }
  
  /**
   * Lit un fichier texte
   */
  readTextFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result?.trim() || '');
      reader.onerror = () => reject(new Error('Erreur de lecture du fichier'));
      reader.onabort = () => reject(new Error('Lecture annulée'));
      reader.readAsText(file);
    });
  }
  
  // ==================== TEST DE CONNEXION API ====================
  
  /**
   * Teste la connexion à l'API du modèle actuel
   */
  async testConnection() {
    const indicator = 'checking';
    this.state.apiStatus = indicator;
    this._triggerConnectionChange(indicator);
    
    try {
      const model = this.config.MODELS[this.state.currentModel];
      if (!model) throw new Error('Modèle non configuré');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      // Requête minimaliste pour tester la connexion
      const response = await fetch(`${this.state.currentApiUrl}${this.config.API_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.modelName,
          messages: [{ role: 'user', content: 'test' }], // CRITICAL: messages requis!
          stream: false,
          max_tokens: 5
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        this.state.apiStatus = 'online';
        this._triggerConnectionChange('online');
        console.log('[Connection Test] OK -', this.state.currentApiUrl);
        return { success: true, status: 'online' };
      } else {
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
      }
      
    } catch (error) {
      this.state.apiStatus = 'offline';
      this._triggerConnectionChange('offline');
      console.error('[Connection Test] Échec:', error.message);
      return { 
        success: false, 
        status: 'offline', 
        error: error.message,
        apiUrl: this.state.currentApiUrl
      };
    }
  }
  
  // ==================== CALLBACKS ====================
  
  /**
   * Configure les callbacks d'événements
   */
  on(event, callback) {
    if (this.state.callbacks.hasOwnProperty(event) && typeof callback === 'function') {
      this.state.callbacks[event] = callback;
    }
    return this; // Chainable
  }
  
  // Déclenchement des callbacks
  _triggerMessage(role, content, isNew = false, messageId = null) {
    if (this.state.callbacks.onMessage) {
      return this.state.callbacks.onMessage({ 
        role, 
        content, 
        isNew, 
        messageId,
        timestamp: Date.now()
      });
    }
    return isNew ? `msg_${Date.now()}` : null;
  }
  
  _updateMessage(messageId, content) {
    if (this.state.callbacks.onMessage) {
      this.state.callbacks.onMessage({ 
        role: 'assistant', 
        content, 
        isNew: false,
        messageId,
        streaming: true
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
  
  _triggerConnectionChange(status) {
    if (this.state.callbacks.onConnectionChange) {
      this.state.callbacks.onConnectionChange(status);
    }
  }
  
  // ==================== UTILITAIRES ====================
  
  /**
   * Chiffrement AES-256 des données locales
   */
  _encryptData(data) {
    if (typeof CryptoJS === 'undefined') {
      console.warn('[Encryption] CryptoJS non disponible');
      return JSON.stringify(data);
    }
    
    try {
      const jsonString = JSON.stringify(data);
      return CryptoJS.AES.encrypt(jsonString, this.config.ENCRYPTION_KEY).toString();
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
      try { return JSON.parse(encryptedData); } catch { return null; }
    }
    
    try {
      const bytes = CryptoJS.AES.decrypt(encryptedData, this.config.ENCRYPTION_KEY);
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
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  /**
   * Formatage basique du markdown
   */
  formatMessage(text) {
    if (!text) return '';
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
      .replace(/\n/g, '<br>');
  }
  
  // ==================== PERSISTENCE ====================
  
  /**
   * Sauvegarde l'état dans localStorage
   */
  _saveToStorage(key = 'tecuit_chat_state') {
    const state = {
      model: this.state.currentModel,
      history: this.state.conversationHistory,
      conversations: this.state.conversations,
      currentConversationId: this.state.currentConversationId,
      timestamp: Date.now()
    };
    
    try {
      const encrypted = this._encryptData(state);
      if (encrypted) {
        localStorage.setItem(key, encrypted);
        return true;
      }
    } catch (e) {
      console.error('[Save Error]', e);
      // Fallback non chiffré si quota dépassé
      try {
        localStorage.setItem(key + '_plain', JSON.stringify(state));
      } catch {}
    }
    return false;
  }
  
  /**
   * Charge l'état depuis localStorage
   */
  _loadFromStorage(key = 'tecuit_chat_state') {
    try {
      // Essai version chiffrée d'abord
      let state = this._decryptData(localStorage.getItem(key));
      
      // Fallback version non chiffrée
      if (!state) {
        const plain = localStorage.getItem(key + '_plain');
        if (plain) state = JSON.parse(plain);
      }
      
      if (!state) return false;
      
      // Restauration sécurisée
      if (state.model && this.config.MODELS[state.model]) {
        this.setModel(state.model);
      }
      
      if (Array.isArray(state.history)) {
        this.state.conversationHistory = state.history;
      }
      
      if (Array.isArray(state.conversations)) {
        this.state.conversations = state.conversations;
      }
      
      if (state.currentConversationId) {
        this.state.currentConversationId = state.currentConversationId;
      }
      
      console.log('[TecuitChat] État restauré');
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
    this.state.currentConversationId = null;
    this._initApiUrl();
    this._saveToStorage();
    console.log('[TecuitChat] Réinitialisé');
  }
  
  // ==================== DEBUG & INFO ====================
  
  /**
   * Retourne les informations de debug
   */
  getDebugInfo() {
    return {
      version: '2.1.0',
      environment: this.isLocalhost ? 'localhost' : 'production',
      currentModel: this.getCurrentModel(),
      apiStatus: this.state.apiStatus,
      isGenerating: this.state.isGenerating,
      historyLength: this.state.conversationHistory.length,
      pendingFile: this.state.pendingFileContent?.filename || null,
      localStorage: {
        available: typeof localStorage !== 'undefined',
        quota: this._estimateStorageUsage()
      }
    };
  }
  
  _estimateStorageUsage() {
    try {
      let total = 0;
      for (const key in localStorage) {
        if (localStorage.hasOwnProperty(key)) {
          total += localStorage[key].length * 2; // UTF-16
        }
      }
      return this._formatBytes(total);
    } catch {
      return 'N/A';
    }
  }
}

// ==================== EXPORTS ====================

// Export pour navigateur
if (typeof window !== 'undefined') {
  window.TecuitChat = TecuitChat;
  window.TecuitConfig = TecuitConfig;
}

// Export pour Node.js / modules ES6
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TecuitChat, TecuitConfig };
}
if (typeof exports !== 'undefined') {
  exports.TecuitChat = TecuitChat;
  exports.TecuitConfig = TecuitConfig;
}

// ==================== INITIALISATION RAPIDE ====================

/**
 * Fonction utilitaire pour initialiser rapidement le chat
 * @param {Object} options - Options de configuration
 * @returns {TecuitChat} Instance du chat
 */
window.initTecuitChat = function(options = {}) {
  const chat = new TecuitChat(options);
  
  // Configuration par défaut des callbacks UI
  chat
    .on('onMessage', (msg) => {
      // À implémenter selon votre UI
      console.log('💬 Message:', { 
        role: msg.role, 
        preview: msg.content?.substring(0, 50),
        isNew: msg.isNew 
      });
    })
    .on('onError', (err) => {
      // Afficher l'erreur dans l'UI
      console.error('❌ Erreur:', err);
    })
    .on('onStatus', (status, data) => {
      console.log('📊 Status:', status, data);
    })
    .on('onModelChange', (model) => {
      console.log('🔄 Modèle:', model.name, `(${model.quantization})`);
    })
    .on('onConnectionChange', (status) => {
      const icons = { checking: '🟡', online: '🟢', offline: '🔴' };
      console.log(`${icons[status] || '⚪'} API: ${status}`);
    });
  
  // Chargement automatique de l'état
  chat._loadFromStorage();
  
  // Test de connexion initial (optionnel)
  setTimeout(() => {
    chat.testConnection().then(result => {
      if (!result.success) {
        console.warn('⚠️ Connexion API échouée au démarrage');
      }
    });
  }, 2000);
  
  return chat;
};

// Auto-initialisation si élément HTML présent
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('tecuit-chat-container')) {
      window.tecuitChat = window.initTecuitChat();
      console.log('🚀 TecuitChat auto-initialisé');
    }
  });
}

// ==================== UTILITAIRES GLOBAUX ====================

/**
 * Vérifie la disponibilité des dépendances
 */
window.checkTecuitDependencies = function() {
  const deps = {
    CryptoJS: typeof CryptoJS !== 'undefined',
    Tesseract: typeof Tesseract !== 'undefined',
    Fetch: typeof fetch !== 'undefined',
    localStorage: typeof localStorage !== 'undefined'
  };
  
  const allOk = Object.values(deps).every(v => v);
  console.log('🔍 Dépendances Tecuit:', deps, allOk ? '✅ OK' : '⚠️ Manquantes');
  
  return { ...deps, allOk };
};

/**
 * Formatage d'erreur utilisateur-friendly
 */
window.formatTecuitError = function(error, language = 'fr') {
  const messages = {
    fr: {
      CORS_ERROR: 'Erreur CORS: Activez "CORS" dans LM Studio → Server Settings',
      MISSING_MESSAGES: "Erreur API: Le champ 'messages' est requis",
      CONNECTION_ERROR: 'Impossible de contacter le serveur IA',
      GENERATION_IN_PROGRESS: 'Veuillez attendre la fin de la génération',
      EMPTY_MESSAGE: 'Le message ne peut pas être vide',
      FILE_TOO_LARGE: 'Fichier trop volumineux (max 50MB)',
      UNKNOWN: 'Une erreur inattendue est survenue'
    },
    en: {
      CORS_ERROR: 'CORS Error: Enable "CORS" in LM Studio → Server Settings',
      MISSING_MESSAGES: "API Error: 'messages' field is required",
      CONNECTION_ERROR: 'Cannot connect to AI server',
      GENERATION_IN_PROGRESS: 'Please wait for generation to complete',
      EMPTY_MESSAGE: 'Message cannot be empty',
      FILE_TOO_LARGE: 'File too large (max 50MB)',
      UNKNOWN: 'An unexpected error occurred'
    }
  };
  
  const lang = messages[language] || messages.fr;
  const code = error?.error || 'UNKNOWN';
  
  return lang[code] || lang.UNKNOWN + ` (${code})`;
};

// Exécution immédiate pour vérification
if (typeof window !== 'undefined') {
  console.log('📦 TecuitChat.js v2.1.0 chargé');
  window.checkTecuitDependencies?.();
}
