// src/services/queue/BaseSecretsProvider.js
import { EventEmitter } from 'events';

class BaseSecretsProvider extends EventEmitter {
    constructor() {
        super();
    }

    async fetchSecrets() {
        throw new Error('Method must be implemented by subclass.');
    }
}
