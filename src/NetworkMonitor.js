import { NetworkCapture } from './cdp/NetworkCapture.js';

export class NetworkMonitor {
    constructor(device) {
        this.device = device;
        this.isMonitoring = false;
        this.capturedData = {
            httpRequests: [],       // raw logcat lines (native-app fallback)
            requests: [],           // structured CDP requests (real wire traffic)
            apiEndpoints: new Set(),
            domains: new Set(),
            responses: [],
            headers: [],
            networkStats: null
        };
        this.monitoringStartTime = null;
        this.logcatProcess = null;
        this._cdp = { dom: null, captures: [], port: null, ownsDom: false };
        this.filters = {
            targetDomains: [], // Only monitor these domains
            ignoreDomains: [], // Ignore these domains
            targetKeywords: [], // Only capture logs with these keywords
            ignoreKeywords: [], // Ignore logs with these keywords
            captureResponses: true,
            captureHeaders: true,
            minResponseSize: 0 // Minimum response size to capture
        };
    }

    async startMonitoring(options = {}) {
        if (this.isMonitoring) {
            console.warn('Network monitoring is already active');
            return;
        }

        console.log('📡 Starting network monitoring...');
        
        // Apply filters from options
        this._applyFilters(options);
        
        // Clear previous data
        this.capturedData = {
            httpRequests: [],
            requests: [],
            apiEndpoints: new Set(),
            domains: new Set(),
            responses: [],
            headers: [],
            networkStats: null
        };

        this.monitoringStartTime = Date.now();
        this.isMonitoring = true;

        // Clear logcat to start fresh
        if (options.clearLogs !== false) {
            await this.device.adb.shell('logcat -c');
            console.log('🧹 Cleared previous logs');
        }

        // Log filter settings
        this._logFilterSettings();

        // Real wire traffic via CDP; best-effort, so a native app with no
        // debuggable Chromium surface silently falls through to logcat.
        if (options.cdp !== false) {
            await this._startCdpCapture(options).catch((e) =>
                console.warn(`⚠️  CDP capture unavailable (${e.message}); using logcat only`));
        }
        await this._startLogcatMonitoring(options);

        console.log('✅ Network monitoring started');
    }

    async _startCdpCapture(options = {}) {
        const adb = this.device.adb;
        const cur = await adb.getCurrentActivity().catch(() => null);
        const pkg = options.package || cur?.package || null;
        const isBrowser = pkg && /chrome|chromium|browser|brave|mises|edge|opera|firefox|duckduck/i.test(pkg);

        let dom, needsOwn;
        if (isBrowser && !options.port && !options.cdpSocket) {
            // Web/Chrome API RE: the action drives via page.dom — share its one
            // connection to the active tab (no second socket, no frozen-tab stalls).
            dom = this.device.page.dom;
            needsOwn = false;
        } else {
            // Native-app WebView (or an explicit target): attach *only* to this
            // app's own DevTools socket. Fast-fail (strict) if it has none so we
            // fall back to logcat instead of grabbing a background Chrome.
            const socket = options.cdpSocket
                || await adb.findDevtoolsSocket(pkg, { strict: true });
            if (!socket) throw new Error(`no DevTools socket for ${pkg || 'app'} (native — logcat only)`);
            dom = this.device.page.chrome({ socket, port: options.port, socketTimeout: options.socketTimeout ?? 4000 });
            needsOwn = true;
        }

        await dom.ensureConnected();   // throws if no Chromium DevTools socket
        this._cdp.dom = dom;
        this._cdp.ownsDom = needsOwn;
        this._cdp.port = dom._port;

        const capture = new NetworkCapture(dom.connection, {
            captureResponses: this.filters.captureResponses,
            maxBodyBytes: options.maxBodyBytes,
            label: dom._target?.url?.slice(0, 80) || 'active-tab',
            filter: this._buildCdpFilter()
        });
        await capture.start();
        this._cdp.captures = [capture];
        console.log(`🌐 CDP network capture on ${dom._target?.url || 'active tab'} (${dom._socket})`);
    }

    _buildCdpFilter() {
        const f = this.filters;
        return (rec) => {
            let host = '';
            try { host = new URL(rec.url).hostname; } catch (_) { /* non-URL */ }
            const hay = `${rec.url} ${rec.method || ''} ${rec.mimeType || ''}`.toLowerCase();

            if (f.ignoreDomains.length && f.ignoreDomains.some(d => host.includes(d))) return false;
            if (f.ignoreKeywords.length && f.ignoreKeywords.some(k => hay.includes(k.toLowerCase()))) return false;
            if (f.targetDomains.length && !f.targetDomains.some(d => host.includes(d))) return false;
            if (f.targetKeywords.length && !f.targetKeywords.some(k => hay.includes(k.toLowerCase()))) return false;
            return true;
        };
    }

    async _stopCdpCapture() {
        if (!this._cdp.captures.length) return;
        const all = [];
        for (const cap of this._cdp.captures) {
            try { all.push(...cap.stop()); } catch (_) { /* ignore */ }
        }
        this._mergeCdpRecords(all);
        // Only tear down the DOM connection if *we* created it; a shared
        // page.dom is left to the caller's lifecycle.
        if (this._cdp.ownsDom && this._cdp.dom) {
            await this._cdp.dom.close().catch(() => {});
        }
        this._cdp = { dom: null, captures: [], port: null, ownsDom: false };
    }

    _mergeCdpRecords(records) {
        for (const rec of records) {
            this.capturedData.requests.push(rec);
            let host = '';
            try { host = new URL(rec.url).hostname; } catch (_) { /* skip */ }
            if (host && this._shouldCaptureDomain(host)) {
                this.capturedData.apiEndpoints.add(rec.url);
                this.capturedData.domains.add(host);
            } else if (!host) {
                this.capturedData.apiEndpoints.add(rec.url);
            }
            const isJson = /json/i.test(rec.mimeType || '')
                || (rec.responseBody && /^\s*[[{]/.test(rec.responseBody));
            if (this.filters.captureResponses && rec.responseBody &&
                rec.responseBody.length >= this.filters.minResponseSize) {
                this.capturedData.responses.push({
                    timestamp: rec.wallTime ? Math.round(rec.wallTime * 1000) : Date.now(),
                    url: rec.url,
                    method: rec.method,
                    status: rec.status,
                    type: isJson ? 'json' : (rec.mimeType || 'body'),
                    size: rec.responseBody.length,
                    data: rec.responseBody
                });
            }
            if (this.filters.captureHeaders) {
                for (const [k, v] of Object.entries(rec.requestHeaders || {})) {
                    if (/^(authorization|cookie|x-|content-type|user-agent)/i.test(k)) {
                        this.capturedData.headers.push({ timestamp: Date.now(), header: `${k}: ${v}`, value: v, direction: 'request', url: rec.url });
                    }
                }
            }
        }
    }

    _applyFilters(options) {
        // Domain targeting
        if (options.targetDomains) {
            this.filters.targetDomains = Array.isArray(options.targetDomains) 
                ? options.targetDomains 
                : [options.targetDomains];
        }
        
        if (options.ignoreDomains) {
            this.filters.ignoreDomains = Array.isArray(options.ignoreDomains) 
                ? options.ignoreDomains 
                : [options.ignoreDomains];
        }

        // Keyword targeting
        if (options.targetKeywords) {
            this.filters.targetKeywords = Array.isArray(options.targetKeywords) 
                ? options.targetKeywords 
                : [options.targetKeywords];
        }
        
        if (options.ignoreKeywords) {
            this.filters.ignoreKeywords = Array.isArray(options.ignoreKeywords) 
                ? options.ignoreKeywords 
                : [options.ignoreKeywords];
        }

        // Other options
        this.filters.captureResponses = options.captureResponses !== false;
        this.filters.captureHeaders = options.captureHeaders !== false;
        this.filters.minResponseSize = options.minResponseSize || 0;
    }

    _logFilterSettings() {
        if (this.filters.targetDomains.length > 0) {
            console.log(`🎯 Targeting domains: ${this.filters.targetDomains.join(', ')}`);
        }
        if (this.filters.ignoreDomains.length > 0) {
            console.log(`🚫 Ignoring domains: ${this.filters.ignoreDomains.join(', ')}`);
        }
        if (this.filters.targetKeywords.length > 0) {
            console.log(`🔍 Targeting keywords: ${this.filters.targetKeywords.join(', ')}`);
        }
        if (this.filters.ignoreKeywords.length > 0) {
            console.log(`🚫 Ignoring keywords: ${this.filters.ignoreKeywords.join(', ')}`);
        }
    }

    async stopMonitoring() {
        if (!this.isMonitoring) {
            console.warn('Network monitoring is not active');
            return this.getResults();
        }

        console.log('📡 Stopping network monitoring...');
        this.isMonitoring = false;

        // Stop the interval so it can't fire during teardown.
        this.cleanup();

        // Drain the real (CDP) capture first, then the logcat fallback.
        await this._stopCdpCapture().catch((e) => console.warn('CDP stop error:', e.message));
        await this._captureFinalLogs();

        // Process and clean up data
        this._processRawData();

        console.log('✅ Network monitoring stopped');
        return this.getResults();
    }

    async _startLogcatMonitoring(options = {}) {
        // We'll capture logs periodically since we can't easily stream them
        this.logcatInterval = setInterval(async () => {
            if (!this.isMonitoring) return;
            
            try {
                await this._captureRecentLogs();
            } catch (error) {
                console.warn('Error capturing logs:', error.message);
            }
        }, options.logInterval || 2000); // Capture every 2 seconds
    }

    async _captureRecentLogs() {
        try {
            // Get logs from the last few seconds
            const recentLogs = await this.device.adb.shell('logcat -d -t 100'); // Last 100 lines
            const lines = recentLogs.split('\n');
            
            for (const line of lines) {
                if (this._shouldProcessLine(line)) {
                    this._processLogLine(line);
                }
            }
        } catch (error) {
            // Silently continue if log capture fails
        }
    }

    _shouldProcessLine(line) {
        if (!line || line.trim().length === 0) return false;

        const lowerLine = line.toLowerCase();
        
        // Apply ignore keywords filter first
        if (this.filters.ignoreKeywords.length > 0) {
            const hasIgnoreKeyword = this.filters.ignoreKeywords.some(keyword => 
                lowerLine.includes(keyword.toLowerCase())
            );
            if (hasIgnoreKeyword) return false;
        }

        // Apply target keywords filter
        if (this.filters.targetKeywords.length > 0) {
            const hasTargetKeyword = this.filters.targetKeywords.some(keyword => 
                lowerLine.includes(keyword.toLowerCase())
            );
            if (!hasTargetKeyword) return false;
        }

        // Check if line contains HTTP-related content
        const httpKeywords = ['http', 'api', 'request', 'response', 'url', 'okhttp', 'volley', 'retrofit'];
        const isHttpRelated = httpKeywords.some(keyword => lowerLine.includes(keyword));
        
        if (!isHttpRelated) return false;

        // Apply domain filtering
        if (this.filters.targetDomains.length > 0 || this.filters.ignoreDomains.length > 0) {
            return this._matchesDomainFilter(line);
        }

        return true;
    }

    _matchesDomainFilter(line) {
        // Extract potential domains from the line
        const domainRegex = /https?:\/\/([^\/\s"'<>{}|\\\^`\[\]]+)/g;
        const matches = line.matchAll(domainRegex);
        const domainsInLine = [];
        
        for (const match of matches) {
            try {
                const url = new URL(`https://${match[1]}`);
                domainsInLine.push(url.hostname);
            } catch (error) {
                // Invalid domain, skip
            }
        }

        // Also check for domain patterns without protocol
        const simpleDomainRegex = /([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        const simpleMatches = line.matchAll(simpleDomainRegex);
        for (const match of simpleMatches) {
            domainsInLine.push(match[1]);
        }

        // Apply ignore domains filter
        if (this.filters.ignoreDomains.length > 0) {
            const hasIgnoreDomain = domainsInLine.some(domain => 
                this.filters.ignoreDomains.some(ignoreDomain => 
                    domain.includes(ignoreDomain) || ignoreDomain.includes(domain)
                )
            );
            if (hasIgnoreDomain) return false;
        }

        // Apply target domains filter
        if (this.filters.targetDomains.length > 0) {
            const hasTargetDomain = domainsInLine.some(domain => 
                this.filters.targetDomains.some(targetDomain => 
                    domain.includes(targetDomain) || targetDomain.includes(domain)
                )
            );
            return hasTargetDomain;
        }

        return true;
    }

    async _captureFinalLogs() {
        try {
            console.log('📋 Capturing final network data...');
            
            // Method 1: Get all recent logs
            const allLogs = await this.device.adb.shell('logcat -d');
            const lines = allLogs.split('\n');
            
            for (const line of lines) {
                if (this._shouldProcessLine(line)) {
                    this._processLogLine(line);
                }
            }

            // Method 2: Try specific log tags (only if they match our filters)
            const httpTags = ['OkHttp', 'Volley', 'HttpURLConnection', 'Retrofit'];
            for (const tag of httpTags) {
                try {
                    const tagLogs = await this.device.adb.shell(`logcat -d -s ${tag}`);
                    tagLogs.split('\n').forEach(line => {
                        if (this._shouldProcessLine(line)) {
                            this._processLogLine(line);
                        }
                    });
                } catch (error) {
                    // Continue if specific tag fails
                }
            }

            // Method 3: Get network statistics
            await this._captureNetworkStats();

        } catch (error) {
            console.warn('Error capturing final logs:', error.message);
        }
    }

    _processLogLine(line) {
        if (!line || line.trim().length === 0) return;

        const lowerLine = line.toLowerCase();
        
        this.capturedData.httpRequests.push({
            timestamp: Date.now(),
            logLine: line,
            type: this._detectLogType(line)
        });

        // Extract URLs and endpoints
        this._extractUrlsFromLine(line);
        
        // Extract JSON responses (if enabled)
        if (this.filters.captureResponses) {
            this._extractResponseData(line);
        }
        
        // Extract headers (if enabled)
        if (this.filters.captureHeaders) {
            this._extractHeaders(line);
        }
    }

    _detectLogType(line) {
        const lowerLine = line.toLowerCase();
        
        if (lowerLine.includes('request')) return 'request';
        if (lowerLine.includes('response')) return 'response';
        if (lowerLine.includes('okhttp')) return 'okhttp';
        if (lowerLine.includes('volley')) return 'volley';
        if (lowerLine.includes('retrofit')) return 'retrofit';
        if (lowerLine.includes('json')) return 'json';
        
        return 'unknown';
    }

    _extractUrlsFromLine(line) {
        // Extract full URLs
        const urlRegex = /https?:\/\/[^\s"'<>{}|\\\^`\[\]]+/g;
        const urls = line.match(urlRegex);
        
        if (urls) {
            urls.forEach(url => {
                // Apply domain filtering to extracted URLs
                try {
                    const urlObj = new URL(url);
                    const domain = urlObj.hostname;
                    
                    // Check if this domain should be captured
                    if (this._shouldCaptureDomain(domain)) {
                        this.capturedData.apiEndpoints.add(url);
                        this.capturedData.domains.add(domain);
                    }
                } catch (error) {
                    // Invalid URL, skip
                }
            });
        }

        // Extract API paths
        const apiRegex = /\/api\/[^\s"'<>{}|\\\^`\[\]]+/g;
        const apiPaths = line.match(apiRegex);
        
        if (apiPaths) {
            apiPaths.forEach(path => this.capturedData.apiEndpoints.add(path));
        }
    }

    _shouldCaptureDomain(domain) {
        // Apply ignore domains filter
        if (this.filters.ignoreDomains.length > 0) {
            const shouldIgnore = this.filters.ignoreDomains.some(ignoreDomain => 
                domain.includes(ignoreDomain) || ignoreDomain.includes(domain)
            );
            if (shouldIgnore) return false;
        }

        // Apply target domains filter
        if (this.filters.targetDomains.length > 0) {
            return this.filters.targetDomains.some(targetDomain => 
                domain.includes(targetDomain) || targetDomain.includes(domain)
            );
        }

        return true;
    }

    _extractResponseData(line) {
        // Look for JSON-like content
        if ((line.includes('{') || line.includes('[')) && 
            (line.includes('}') || line.includes(']'))) {
            
            // Apply minimum size filter
            if (line.length >= this.filters.minResponseSize) {
                this.capturedData.responses.push({
                    timestamp: Date.now(),
                    data: line,
                    type: 'json',
                    size: line.length
                });
            }
        }
    }

    _extractHeaders(line) {
        // Look for HTTP headers
        const headerPatterns = [
            /content-type:\s*([^\s\n\r]+)/i,
            /authorization:\s*([^\s\n\r]+)/i,
            /user-agent:\s*([^\n\r]+)/i,
            /accept:\s*([^\n\r]+)/i,
            /x-[\w-]+:\s*([^\n\r]+)/i
        ];

        headerPatterns.forEach(pattern => {
            const match = line.match(pattern);
            if (match) {
                this.capturedData.headers.push({
                    timestamp: Date.now(),
                    header: match[0],
                    value: match[1]
                });
            }
        });
    }

    async _captureNetworkStats() {
        try {
            // Get network connection info
            const netstat = await this.device.adb.shell('cat /proc/net/tcp');
            const networkInfo = await this.device.adb.shell('dumpsys connectivity');
            
            this.capturedData.networkStats = {
                tcp: netstat.split('\n').slice(0, 20), // Limit output
                connectivity: networkInfo.split('\n').slice(0, 50),
                timestamp: Date.now()
            };
        } catch (error) {
            console.warn('Could not capture network stats:', error.message);
        }
    }

    _processRawData() {
        // Convert Sets to Arrays for JSON serialization
        this.capturedData.apiEndpoints = Array.from(this.capturedData.apiEndpoints);
        this.capturedData.domains = Array.from(this.capturedData.domains);

        // Remove duplicates and sort
        this.capturedData.apiEndpoints = [...new Set(this.capturedData.apiEndpoints)].sort();
        this.capturedData.domains = [...new Set(this.capturedData.domains)].sort();

        // Group requests by type
        this.capturedData.requestsByType = this._groupRequestsByType();
        
        // Extract unique API patterns
        this.capturedData.apiPatterns = this._extractApiPatterns();
    }

    _groupRequestsByType() {
        const grouped = {};
        
        this.capturedData.httpRequests.forEach(req => {
            const type = req.type;
            if (!grouped[type]) {
                grouped[type] = [];
            }
            grouped[type].push(req);
        });
        
        return grouped;
    }

    _extractApiPatterns() {
        const patterns = new Set();
        
        this.capturedData.apiEndpoints.forEach(endpoint => {
            // Extract API patterns like /api/v1/search, /api/activities, etc.
            const pathMatch = endpoint.match(/\/api\/[^?#]+/);
            if (pathMatch) {
                patterns.add(pathMatch[0]);
            }
        });
        
        return Array.from(patterns);
    }

    getResults() {
        const monitoringDuration = this.monitoringStartTime ? 
            Date.now() - this.monitoringStartTime : 0;

        const sizeOf = (v) => Array.isArray(v) ? v.length : (v instanceof Set ? v.size : 0);
        return {
            monitoringDuration,
            filters: this.filters,
            summary: {
                cdpRequests: this.capturedData.requests.length,
                logcatLines: this.capturedData.httpRequests.length,
                totalRequests: this.capturedData.requests.length + this.capturedData.httpRequests.length,
                uniqueEndpoints: sizeOf(this.capturedData.apiEndpoints),
                uniqueDomains: sizeOf(this.capturedData.domains),
                responses: this.capturedData.responses.length,
                headers: this.capturedData.headers.length
            },
            data: {
                ...this.capturedData,
                // Add convenience accessors
                allUrls: Array.isArray(this.capturedData.apiEndpoints)
                    ? this.capturedData.apiEndpoints : Array.from(this.capturedData.apiEndpoints),
                allDomains: Array.isArray(this.capturedData.domains)
                    ? this.capturedData.domains : Array.from(this.capturedData.domains),
                jsonResponses: this.capturedData.responses.filter(r => r.type === 'json')
            }
        };
    }

    // Convenience methods for common use cases
    async monitorForDuration(durationMs, options = {}) {
        await this.startMonitoring(options);
        
        return new Promise((resolve) => {
            setTimeout(async () => {
                const results = await this.stopMonitoring();
                resolve(results);
            }, durationMs);
        });
    }

    async monitorAction(actionFunction, options = {}) {
        await this.startMonitoring(options);

        let actionError = null;
        try {
            await actionFunction();
        } catch (error) {
            // Capture the error but still stop cleanly and return what we saw.
            actionError = error;
            console.warn('⚠️  Action threw during monitoring:', error.message);
        }

        const results = await this.stopMonitoring();
        if (actionError) results.actionError = actionError.message;
        return results;
    }

    // Get specific types of data
    getApiEndpoints() {
        return this.capturedData.apiEndpoints;
    }

    getDomains() {
        return this.capturedData.domains;
    }

    getJsonResponses() {
        return this.capturedData.responses.filter(r => r.type === 'json');
    }

    getRequestHeaders() {
        return this.capturedData.headers;
    }

    // Search and filter methods
    findEndpointsContaining(searchTerm) {
        return this.capturedData.apiEndpoints.filter(endpoint => 
            endpoint.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }

    findDomainsContaining(searchTerm) {
        return this.capturedData.domains.filter(domain => 
            domain.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }

    findResponsesContaining(searchTerm) {
        return this.capturedData.responses.filter(response => 
            response.data.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }

    // Export methods
    async exportToFile(filename = 'network-analysis.json') {
        const results = this.getResults();
        const { writeFile } = await import('fs/promises');
        await writeFile(filename, JSON.stringify(results, null, 2));
        return filename;
    }

    /** Structured CDP requests (real wire traffic): method/url/status/headers/body. */
    getRequests() {
        return this.capturedData.requests || [];
    }

    // Cleanup
    cleanup() {
        if (this.logcatInterval) {
            clearInterval(this.logcatInterval);
            this.logcatInterval = null;
        }
        
        this.isMonitoring = false;
    }
}
