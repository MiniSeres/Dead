(function() {
    'use strict';

    class LogSystem {
        constructor(containerId) {
            this.container = document.getElementById(containerId);
            this.entries = [];
            this.maxEntries = 500;
        }

        _getTimestamp() {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' +
                   pad(now.getSeconds()) + '.' + String(now.getMilliseconds()).padStart(3, '0');
        }

        log(message, type = 'info') {
            const time = this._getTimestamp();
            const entry = { time, message, type };
            this.entries.push(entry);
            if (this.entries.length > this.maxEntries) {
                this.entries.shift();
            }
            this.render();
            this.container.scrollTop = this.container.scrollHeight;
            document.getElementById('logCount').textContent = this.entries.length + ' entries';
            return entry;
        }

        render() {
            if (!this.container) return;
            this.container.innerHTML = this.entries.map(e => {
                const cls = e.type;
                const icon = e.type === 'success' ? '✔' :
                             e.type === 'error' ? '✘' :
                             e.type === 'warning' ? '⚠' : 'ℹ';
                return `<div class="log-entry ${cls}">
                    <span class="time">${e.time}</span>
                    <span class="msg">${icon} ${e.message}</span>
                </div>`;
            }).join('');
        }

        clear() {
            this.entries = [];
            this.render();
            document.getElementById('logCount').textContent = '0 entries';
        }
    }

    class CrawlerEngine {
        constructor(options = {}) {
            this.concurrent = options.concurrent || 5;
            this.timeout = options.timeout || 10000;
            this.queue = [];
            this.processing = new Set();
            this.done = new Map();
            this.failed = new Map();
            this.total = 0;
            this.success = 0;
            this.failCount = 0;
            this.isRunning = false;
            this.shouldStop = false;
            this.baseDomain = '';
            this.startTime = 0;
            this.elapsed = 0;
            this.onFileDone = null;
            this.onLog = null;
            this.onProgress = null;
            this.fileTree = [];
        }

        _getDomain(url) {
            try {
                return new URL(url).hostname;
            } catch { return ''; }
        }

        _isSameDomain(url) {
            try {
                const u = new URL(url, this.baseDomain);
                return u.hostname === this.baseDomain || u.hostname === '';
            } catch { return false; }
        }

        _normalizeUrl(url, base) {
            try {
                return new URL(url, base).href;
            } catch { return null; }
        }

        _extractAssets(html, baseUrl) {
            const assets = new Set();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            
            doc.querySelectorAll('link[rel="stylesheet"][href]').forEach(el => {
                const href = this._normalizeUrl(el.getAttribute('href'), baseUrl);
                if (href) assets.add(href);
            });
            doc.querySelectorAll('script[src]').forEach(el => {
                const src = this._normalizeUrl(el.getAttribute('src'), baseUrl);
                if (src) assets.add(src);
            });
            doc.querySelectorAll('img[src]').forEach(el => {
                const src = this._normalizeUrl(el.getAttribute('src'), baseUrl);
                if (src) assets.add(src);
            });
            doc.querySelectorAll('iframe[src]').forEach(el => {
                const src = this._normalizeUrl(el.getAttribute('src'), baseUrl);
                if (src) assets.add(src);
            });
            doc.querySelectorAll('link[rel="icon"][href]').forEach(el => {
                const href = this._normalizeUrl(el.getAttribute('href'), baseUrl);
                if (href) assets.add(href);
            });
            doc.querySelectorAll('link[rel="manifest"][href]').forEach(el => {
                const href = this._normalizeUrl(el.getAttribute('href'), baseUrl);
                if (href) assets.add(href);
            });
            
            return Array.from(assets);
        }

        _getFileType(url) {
            const ext = url.split('.').pop().split('?')[0].toLowerCase();
            const map = {
                'html': 'html', 'htm': 'html',
                'css': 'css',
                'js': 'js',
                'png': 'image', 'jpg': 'image', 'jpeg': 'image', 'gif': 'image', 'svg': 'image', 'webp': 'image',
                'json': 'json',
                'xml': 'xml',
                'txt': 'text',
                'woff': 'font', 'woff2': 'font', 'ttf': 'font', 'otf': 'font',
                'ico': 'icon',
                'pdf': 'pdf'
            };
            return map[ext] || 'other';
        }

        _getFileName(url) {
            try {
                const u = new URL(url);
                let path = u.pathname;
                if (path.endsWith('/')) path += 'index.html';
                return path.split('/').filter(Boolean).pop() || 'index.html';
            } catch {
                return 'unknown';
            }
        }

        async _fetchWithTimeout(url) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeout);
            try {
                const res = await fetch(url, {
                    signal: controller.signal,
                    mode: 'cors',
                    headers: { 'User-Agent': 'WebDumpBot/3.0' }
                });
                clearTimeout(timer);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const content = await res.text();
                return { content, size: content.length };
            } catch (err) {
                clearTimeout(timer);
                throw err;
            }
        }

        async _processUrl(url) {
            if (this.shouldStop) return;
            if (this.done.has(url) || this.failed.has(url)) return;

            this.processing.add(url);
            this.total++;

            try {
                const result = await this._fetchWithTimeout(url);
                const fileType = this._getFileType(url);
                const fileName = this._getFileName(url);
                
                this.done.set(url, {
                    content: result.content,
                    type: fileType,
                    size: result.size,
                    time: Date.now(),
                    fileName: fileName
                });
                this.success++;
                
                this._log(`✔ ${fileName} (${(result.size/1024).toFixed(1)}KB)`, 'success');
                
                this.fileTree.push({
                    url,
                    name: fileName,
                    type: fileType,
                    status: 'success',
                    size: result.size,
                    time: new Date().toISOString()
                });

                if (fileType === 'html') {
                    const assets = this._extractAssets(result.content, url);
                    for (const asset of assets) {
                        if (this._isSameDomain(asset) && !this.done.has(asset) && !this.failed.has(asset) && !this.queue.includes(asset)) {
                            this.queue.push(asset);
                        }
                    }
                }

                if (this.onFileDone) this.onFileDone(url, 'success', result);

            } catch (err) {
                this.failed.set(url, err.message);
                this.failCount++;
                this._log(`✘ ${this._getFileName(url)} — ${err.message}`, 'error');
                
                this.fileTree.push({
                    url,
                    name: this._getFileName(url),
                    type: this._getFileType(url),
                    status: 'fail',
                    error: err.message,
                    time: new Date().toISOString()
                });
                
                if (this.onFileDone) this.onFileDone(url, 'fail', { error: err.message });
            }

            this.processing.delete(url);
            if (this.onProgress) this.onProgress(this.total, this.success, this.failCount);
            this._updateProgress();
        }

        _log(msg, type = 'info') {
            if (this.onLog) this.onLog(msg, type);
        }

        _updateProgress() {
            const total = this.done.size + this.failed.size;
            const done = this.done.size;
            if (this.onProgress) this.onProgress(total, this.success, this.failCount);
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            document.getElementById('statProgress').textContent = pct + '%';
            document.getElementById('progressBar').style.width = pct + '%';
            document.getElementById('statTotal').textContent = total;
            document.getElementById('statSuccess').textContent = this.success;
            document.getElementById('statFailed').textContent = this.failCount;
            document.getElementById('fileCount').textContent = total + ' files';
        }

        _updateElapsed() {
            if (!this.isRunning) return;
            this.elapsed = (Date.now() - this.startTime) / 1000;
            document.getElementById('statTime').textContent = this.elapsed.toFixed(1) + 's';
            requestAnimationFrame(() => this._updateElapsed());
        }

        async start(baseUrl) {
            if (this.isRunning) return;
            this.isRunning = true;
            this.shouldStop = false;
            this.queue = [];
            this.done = new Map();
            this.failed = new Map();
            this.fileTree = [];
            this.total = 0;
            this.success = 0;
            this.failCount = 0;
            this.baseDomain = this._getDomain(baseUrl);
            this.startTime = Date.now();

            this._log(`🚀 Starting crawl: ${baseUrl}`, 'info');
            this._log(`📡 Domain: ${this.baseDomain}`, 'info');

            this.queue.push(baseUrl);

            document.getElementById('statusBadge').textContent = '● CRAWLING';
            document.getElementById('statusBadge').className = 'status-badge active';
            document.getElementById('btnStart').disabled = true;
            document.getElementById('btnStop').disabled = false;
            document.getElementById('btnDownload').disabled = true;
            document.getElementById('fileTree').innerHTML = '<div style="color: var(--text-secondary); padding: 8px;">⏳ Crawling...</div>';

            this._updateElapsed();

            while (this.queue.length > 0 && !this.shouldStop) {
                const batch = this.queue.splice(0, this.concurrent);
                await Promise.allSettled(batch.map(url => this._processUrl(url)));
            }

            while (this.processing.size > 0 && !this.shouldStop) {
                await new Promise(r => setTimeout(r, 200));
            }

            this.isRunning = false;
            this.elapsed = (Date.now() - this.startTime) / 1000;
            document.getElementById('statTime').textContent = this.elapsed.toFixed(1) + 's';

            if (this.shouldStop) {
                this._log('⏹ Crawl stopped by user', 'warning');
                document.getElementById('statusBadge').textContent = '● STOPPED';
                document.getElementById('statusBadge').className = 'status-badge error';
            } else {
                this._log(`✅ Crawl completed! ${this.success} files, ${this.failCount} errors`, 'success');
                document.getElementById('statusBadge').textContent = '● DONE';
                document.getElementById('statusBadge').className = 'status-badge';
                document.getElementById('btnDownload').disabled = false;
                this._showToast('✅ Crawl completed successfully!', 'success');
            }

            document.getElementById('btnStart').disabled = false;
            document.getElementById('btnStop').disabled = true;
            this._updateProgress();
            this._renderFileTree();
        }

        stop() {
            if (this.isRunning) {
                this.shouldStop = true;
                this._log('⏹ Stopping crawler...', 'warning');
            }
        }

        _renderFileTree() {
            const container = document.getElementById('fileTree');
            if (this.fileTree.length === 0) {
                container.innerHTML = '<div style="color: var(--text-secondary); padding: 8px;">No files crawled.</div>';
                return;
            }
            container.innerHTML = this.fileTree.map(f => {
                const icon = f.type === 'html' ? '📄' :
                            f.type === 'css' ? '🎨' :
                            f.type === 'js' ? '⚡' :
                            f.type === 'image' ? '🖼️' :
                            f.type === 'font' ? '🔤' :
                            f.type === 'json' ? '📋' : '📎';
                const statusClass = f.status === 'success' ? 'success' : 'fail';
                const statusText = f.status === 'success' ? '✅' : '❌';
                const timeStr = f.time ? new Date(f.time).toLocaleTimeString() : '';
                return `<div class="file-item">
                    <span class="icon">${icon}</span>
                    <span class="name">${f.name}</span>
                    <span class="status ${statusClass}">${statusText}</span>
                    <span class="time">${timeStr}</span>
                </div>`;
            }).join('');
        }

        _showToast(message, type = 'info') {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.textContent = message;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(50px)';
                setTimeout(() => toast.remove(), 400);
            }, 4000);
        }

        downloadDump() {
            if (this.done.size === 0) {
                this._showToast('No data to download!', 'error');
                return;
            }

            const zip = {
                files: {},
                addFile: function(path, content) {
                    this.files[path] = content;
                }
            };

            for (const [url, data] of this.done) {
                const fileName = data.fileName || this._getFileName(url);
                const path = fileName;
                zip.addFile(path, data.content);
            }

            const json = JSON.stringify(zip.files, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `dump_${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
            this._showToast(`💾 Downloaded ${this.done.size} files as JSON`, 'success');
        }

        clearAll() {
            this.stop();
            this.done = new Map();
            this.failed = new Map();
            this.fileTree = [];
            this.total = 0;
            this.success = 0;
            this.failCount = 0;
            this.queue = [];
            this.processing = new Set();
            this.isRunning = false;
            this.shouldStop = false;
            
            document.getElementById('statTotal').textContent = '0';
            document.getElementById('statSuccess').textContent = '0';
            document.getElementById('statFailed').textContent = '0';
            document.getElementById('statTime').textContent = '0.0s';
            document.getElementById('statProgress').textContent = '0%';
            document.getElementById('progressBar').style.width = '0%';
            document.getElementById('fileCount').textContent = '0 files';
            document.getElementById('fileTree').innerHTML = '<div style="color: var(--text-secondary); padding: 8px;">Cleared.</div>';
            document.getElementById('statusBadge').textContent = '● IDLE';
            document.getElementById('statusBadge').className = 'status-badge';
            document.getElementById('btnStart').disabled = false;
            document.getElementById('btnStop').disabled = true;
            document.getElementById('btnDownload').disabled = true;
            
            const log = new LogSystem('logContainer');
            log.clear();
            log.log('🧹 System cleared', 'info');
            this._showToast('🧹 All data cleared', 'info');
        }
    }

    const logSystem = new LogSystem('logContainer');
    const crawler = new CrawlerEngine({
        concurrent: 5,
        timeout: 10000
    });

    crawler.onLog = (msg, type) => {
        logSystem.log(msg, type);
    };

    crawler.onFileDone = (url, status, data) => {
        crawler._renderFileTree();
    };

    crawler.onProgress = (total, success, fail) => {
    };

    document.getElementById('btnStart').addEventListener('click', async () => {
        const urlInput = document.getElementById('urlInput');
        let url = urlInput.value.trim();
        if (!url) {
            logSystem.log('❌ Please enter a URL', 'error');
            return;
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
            urlInput.value = url;
        }
        await crawler.start(url);
    });

    document.getElementById('btnStop').addEventListener('click', () => {
        crawler.stop();
    });

    document.getElementById('btnDownload').addEventListener('click', () => {
        crawler.downloadDump();
    });

    document.getElementById('btnClear').addEventListener('click', () => {
        crawler.clearAll();
    });

    document.getElementById('urlInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('btnStart').click();
        }
    });

    logSystem.log('🕸️ Web Dump Master v3.0 ready', 'info');
    logSystem.log('💡 Enter a URL and hit START to begin', 'info');

})();
