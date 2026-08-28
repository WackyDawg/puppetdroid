export class PuppetdroidError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PuppetdroidError';
    }
}

export class ElementNotFoundError extends PuppetdroidError {
    constructor(selector) {
        super(`Element not found: ${JSON.stringify(selector)}`);
        this.name = 'ElementNotFoundError';
    }
}

export class TimeoutError extends PuppetdroidError {
    constructor(message) {
        super(message);
        this.name = 'TimeoutError';
    }
}

export class DeviceNotConnectedError extends PuppetdroidError {
    constructor() {
        super('Android device not connected or ADB not available');
        this.name = 'DeviceNotConnectedError';
    }
}
