class App {
    constructor() {
        this.ws = null;
        this.graph = new NetworkGraph('graph-container');
        this.nodes = {};
        this.haDevices = {}; // HA device registry cache (by node_id)
        this.haDevicesBySerial = {}; // HA device registry cache (by serial)
        this.matterConnected = false;
        this.haConnected = false;

        this.init();
    }

    init() {
        document.getElementById('reconnectBtn').addEventListener('click', () => this.connect());
        document.getElementById('settingsBtn').addEventListener('click', () => this.openSettings());
        document.getElementById('modalCloseBtn').addEventListener('click', () => this.closeSettings());
        document.getElementById('settingsCancelBtn').addEventListener('click', () => this.closeSettings());
        document.getElementById('settingsSaveBtn').addEventListener('click', () => this.saveSettings());

        // Close modal on overlay click
        document.getElementById('settingsModal').addEventListener('click', (e) => {
            if (e.target.id === 'settingsModal') {
                this.closeSettings();
            }
        });

        // Close modal on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeSettings();
            }
        });

        // Collapsible panels
        document.querySelectorAll('.collapsible .panel-header').forEach(header => {
            header.addEventListener('click', () => {
                const panel = header.closest('.collapsible');
                panel.classList.toggle('collapsed');
                // Save state to localStorage
                const panelName = header.dataset.panel;
                localStorage.setItem(`panel_${panelName}_collapsed`, panel.classList.contains('collapsed'));
                // Trigger graph resize after animation
                setTimeout(() => {
                    if (this.graph?.network) {
                        this.graph.network.redraw();
                        this.graph.network.fit();
                    }
                }, 250);
            });
        });

        // Restore collapsed state from localStorage
        document.querySelectorAll('.collapsible .panel-header').forEach(header => {
            const panelName = header.dataset.panel;
            const isCollapsed = localStorage.getItem(`panel_${panelName}_collapsed`) === 'true';
            if (isCollapsed) {
                header.closest('.collapsible').classList.add('collapsed');
            }
        });

        // Fetch HA devices first (for names), then connect
        this.fetchHADevices().then(() => {
            this.connect();
        });
    }

    getSettings() {
        return {
            haHost: localStorage.getItem('haHost') || 'homeassistant.local',
            haPort: localStorage.getItem('haPort') || '8123',
            haToken: localStorage.getItem('haToken') || '',
            matterPort: localStorage.getItem('matterPort') || '5580'
        };
    }

    openSettings() {
        const settings = this.getSettings();
        document.getElementById('haHost').value = settings.haHost;
        document.getElementById('haPort').value = settings.haPort;
        document.getElementById('haToken').value = settings.haToken;
        document.getElementById('matterPort').value = settings.matterPort;
        document.getElementById('settingsModal').classList.add('active');
    }

    closeSettings() {
        document.getElementById('settingsModal').classList.remove('active');
    }

    saveSettings() {
        const haHost = document.getElementById('haHost').value.trim() || 'homeassistant.local';
        const haPort = document.getElementById('haPort').value.trim() || '8123';
        const haToken = document.getElementById('haToken').value.trim();
        const matterPort = document.getElementById('matterPort').value.trim() || '5580';

        localStorage.setItem('haHost', haHost);
        localStorage.setItem('haPort', haPort);
        localStorage.setItem('haToken', haToken);
        localStorage.setItem('matterPort', matterPort);

        this.closeSettings();

        // Reconnect with new settings
        this.fetchHADevices().then(() => {
            this.connect();
        });
    }

    fetchHADevices() {
        return new Promise((resolve) => {
            const settings = this.getSettings();
            this.setHAConnected(false);

            if (!settings.haToken) {
                console.log('No HA token found. Click "Settings" button to configure.');
                resolve();
                return;
            }

            const wsURL = `ws://${settings.haHost}:${settings.haPort}/api/websocket`;

            console.log('Connecting to HA WebSocket:', wsURL);
            const ws = new WebSocket(wsURL);
            let msgId = 1;

            const timeout = setTimeout(() => {
                console.log('HA WebSocket timeout');
                ws.close();
                resolve();
            }, 10000);

            ws.onopen = () => {
                console.log('HA WebSocket connected, authenticating...');
            };

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);

                if (msg.type === 'auth_required') {
                    ws.send(JSON.stringify({ type: 'auth', access_token: settings.haToken }));
                }
                else if (msg.type === 'auth_ok') {
                    console.log('HA authenticated, fetching device registry...');
                    this.setHAConnected(true);
                    // Fetch device registry which has Matter node IDs
                    ws.send(JSON.stringify({ id: msgId++, type: 'config/device_registry/list' }));
                }
                else if (msg.type === 'auth_invalid') {
                    console.error('HA auth failed:', msg.message);
                    this.setHAConnected(false);
                    clearTimeout(timeout);
                    ws.close();
                    resolve();
                }
                else if (msg.type === 'result' && msg.success) {
                    clearTimeout(timeout);
                    const devices = msg.result || [];
                    console.log('Fetched', devices.length, 'HA devices');

                    // Find Matter devices by looking for matter in identifiers
                    const matterDevices = devices.filter(d =>
                        d.identifiers?.some(i => i[0] === 'matter')
                    );
                    console.log('Matter devices found:', matterDevices.length);

                    matterDevices.forEach(device => {
                        const matterIdent = device.identifiers?.find(i => i[0] === 'matter');
                        const matterId = matterIdent?.[1];

                        if (matterId) {
                            let nodeId = null;
                            const deviceName = device.name_by_user || device.name || matterId;

                            // Format: deviceid_{fabricId}-{nodeIdHex}-MatterNodeDevice (primary device)
                            // or: deviceid_{fabricId}-{nodeIdHex}-{endpoint} (child endpoint)
                            const primaryDeviceMatch = matterId.match(/^deviceid_[A-F0-9]+-([A-F0-9]+)-MatterNodeDevice$/i);
                            if (primaryDeviceMatch) {
                                // This is the primary device entry - use its name
                                nodeId = parseInt(primaryDeviceMatch[1], 16);
                                if (!isNaN(nodeId)) {
                                    this.haDevices[nodeId] = {
                                        friendly_name: deviceName,
                                        device_id: device.id,
                                        matter_id: matterId
                                    };
                                }
                            } else {
                                // Check for endpoint format (child device)
                                const endpointMatch = matterId.match(/^deviceid_[A-F0-9]+-([A-F0-9]+)-(\d+)$/i);
                                if (endpointMatch) {
                                    // Only use if we don't already have a name for this node
                                    nodeId = parseInt(endpointMatch[1], 16);
                                    if (!isNaN(nodeId) && !this.haDevices[nodeId]) {
                                        this.haDevices[nodeId] = {
                                            friendly_name: deviceName,
                                            device_id: device.id,
                                            matter_id: matterId
                                        };
                                    }
                                }
                            }

                            // Format: serial_{serialNumber} - store by serial for later matching
                            const serialMatch = matterId.match(/^serial_(.+)$/);
                            if (serialMatch) {
                                const serial = serialMatch[1];
                                if (!this.haDevicesBySerial) this.haDevicesBySerial = {};
                                this.haDevicesBySerial[serial] = {
                                    friendly_name: deviceName,
                                    device_id: device.id,
                                    matter_id: matterId
                                };
                            }
                        }
                    });

                    console.log('Mapped by node_id:', Object.keys(this.haDevices).length, this.haDevices);
                    console.log('Mapped by serial:', Object.keys(this.haDevicesBySerial || {}).length);
                    ws.close();
                    resolve();
                }
            };

            ws.onerror = (e) => {
                console.error('HA WebSocket error:', e);
                clearTimeout(timeout);
                resolve();
            };

            ws.onclose = () => {
                clearTimeout(timeout);
                resolve();
            };
        });
    }

    connect() {
        if (this.ws) {
            this.ws.close();
        }

        const settings = this.getSettings();
        const url = `ws://${settings.haHost}:${settings.matterPort}/ws`;
        console.log(`Connecting to ${url}...`);

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log('Matter WebSocket Connected');
            this.setMatterConnected(true);

            // Start listening
            this.sendMessage({
                message_id: "1",
                command: "start_listening",
                args: {}
            });

            // Fetch initial nodes if just connected (start_listening returns them)
        };

        this.ws.onclose = () => {
            console.log('Matter WebSocket Disconnected');
            this.setMatterConnected(false);
        };

        this.ws.onerror = (error) => {
            console.error('Matter WebSocket Error', error);
            this.setMatterConnected(false);
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (e) {
                console.error('Error parsing message', e);
            }
        };
    }

    sendMessage(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    setMatterConnected(connected) {
        this.matterConnected = connected;
        const statusDot = document.querySelector('#matterStatus .status-dot');
        if (connected) {
            statusDot.classList.add('connected');
        } else {
            statusDot.classList.remove('connected');
        }
    }

    setHAConnected(connected) {
        this.haConnected = connected;
        const statusDot = document.querySelector('#haStatus .status-dot');
        if (connected) {
            statusDot.classList.add('connected');
        } else {
            statusDot.classList.remove('connected');
        }
    }

    showUpdateNotification(nodeId) {
        // Create or get the update indicator
        let indicator = document.querySelector('.update-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'update-indicator';
            document.body.appendChild(indicator);
        }

        const nodeName = this.nodes[nodeId] ? this.graph.getDeviceName(this.nodes[nodeId]) : `Node ${nodeId}`;
        indicator.textContent = `Updated: ${nodeName}`;
        indicator.classList.add('show');

        // Highlight the card if visible
        const card = document.querySelector(`.device-card[data-node-id="${nodeId}"], .bridge-card[data-node-id="${nodeId}"]`);
        if (card) {
            card.classList.remove('updated');
            void card.offsetWidth; // Trigger reflow
            card.classList.add('updated');
            setTimeout(() => card.classList.remove('updated'), 600);
        }

        // Hide notification after delay
        clearTimeout(this.updateNotificationTimeout);
        this.updateNotificationTimeout = setTimeout(() => {
            indicator.classList.remove('show');
        }, 2000);
    }

    handleMessage(message) {
        // Initial node list from start_listening
        if (message.message_id === "1" && message.result) {
            console.log('Received initial nodes', message.result);
            this.updateNodes(message.result);
        }

        // Events
        if (message.event === 'node_updated' || message.event === 'node_added') {
            // For single node updates/adds, we might want to merge into our state
            // But the API seems to return the full node object in data for these events based on earlier analysis?
            // Actually, looking at main.js: node_added returns data as node object.
            // node_updated returns data as node object.
            // We can just re-process this specific node.
            if (message.data) {
                this.updateSingleNode(message.data);
            }
        }
    }

    updateNodes(nodesList) {
        this.nodes = {};
        nodesList.forEach(node => {
            this.nodes[node.node_id] = node;
        });
        this.graph.render(this.nodes, this.haDevices, this.haDevicesBySerial);
    }

    updateSingleNode(nodeData) {
        this.nodes[nodeData.node_id] = nodeData;

        // Show update notification
        this.showUpdateNotification(nodeData.node_id);

        // Optimize: verify if we can just update one node instead of full re-render
        // For now, full re-render is safer to keep edges correct
        this.graph.render(this.nodes, this.haDevices, this.haDevicesBySerial);
    }
}

// Start the app
window.app = new App();
