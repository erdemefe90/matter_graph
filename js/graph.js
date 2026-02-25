class NetworkGraph {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.network = null;
        this.haDevices = {};
        this.haDevicesBySerial = {};
        this.nodesMap = {};
        this.layoutMode = localStorage.getItem('graphLayout') || 'default';
        this.anonymized = false;
        this.data = {
            nodes: new vis.DataSet([]),
            edges: new vis.DataSet([])
        };
        this.options = {
            nodes: {
                shape: 'icon',
                size: 25,
                font: {
                    face: 'Inter',
                    size: 11,
                    color: '#ffffff',
                    strokeWidth: 3,
                    strokeColor: 'rgba(0,0,0,0.7)',
                    vadjust: 2
                },
                icon: {
                    face: '"Font Awesome 6 Free"',
                    weight: '900',
                    size: 30,
                    color: '#03a9f4'
                }
            },
            edges: {
                width: 2,
                color: { color: 'rgba(3, 169, 244, 0.4)', highlight: '#4fc3f7' },
                smooth: {
                    type: 'continuous'
                }
            },
            groups: {
                router: {
                    icon: {
                        face: '"Font Awesome 6 Free"',
                        weight: '900',
                        size: 35,
                        color: '#03a9f4'
                    }
                },
                endDevice: {
                    icon: {
                        face: '"Font Awesome 6 Free"',
                        weight: '900',
                        size: 25,
                        color: '#4db6ac'
                    }
                }
            },
            physics: {
                stabilization: {
                    enabled: true,
                    iterations: 300
                },
                barnesHut: {
                    gravitationalConstant: -4000,
                    centralGravity: 0.3,
                    springLength: 150,
                    springConstant: 0.04,
                    damping: 0.09,
                    avoidOverlap: 0.8
                }
            },
            layout: {
                improvedLayout: true,
                randomSeed: 42
            },
            interaction: {
                hover: true,
                tooltipDelay: 200,
                dragNodes: true
            }
        };
    }

    getLayoutOptions(mode) {
        switch (mode) {
            case 'hierarchical':
                return {
                    layout: {
                        hierarchical: {
                            enabled: true,
                            direction: 'UD',
                            sortMethod: 'hubsize',
                            levelSeparation: 120,
                            nodeSpacing: 150,
                            treeSpacing: 200
                        }
                    },
                    physics: {
                        enabled: true,
                        hierarchicalRepulsion: {
                            centralGravity: 0.2,
                            springLength: 120,
                            springConstant: 0.02,
                            nodeDistance: 150,
                            damping: 0.09,
                            avoidOverlap: 0.8
                        },
                        stabilization: { enabled: true, iterations: 300 }
                    }
                };
            case 'radial':
                return {
                    layout: {
                        improvedLayout: true,
                        randomSeed: 42,
                        hierarchical: { enabled: false }
                    },
                    physics: {
                        enabled: true,
                        stabilization: { enabled: true, iterations: 300 },
                        barnesHut: {
                            gravitationalConstant: -2000,
                            centralGravity: 0.8,
                            springLength: 100,
                            springConstant: 0.06,
                            damping: 0.09,
                            avoidOverlap: 0.8
                        }
                    }
                };
            default: // 'default' - TBR-central
                return {
                    layout: {
                        improvedLayout: true,
                        randomSeed: 42,
                        hierarchical: { enabled: false }
                    },
                    physics: {
                        enabled: true,
                        stabilization: { enabled: true, iterations: 300 },
                        barnesHut: {
                            gravitationalConstant: -4000,
                            centralGravity: 0.3,
                            springLength: 150,
                            springConstant: 0.04,
                            damping: 0.09,
                            avoidOverlap: 0.8
                        }
                    }
                };
        }
    }

    setLayout(mode) {
        this.layoutMode = mode;
        localStorage.setItem('graphLayout', mode);
        this.relayout();
    }

    relayout() {
        if (!this.network) return;

        const layoutOpts = this.getLayoutOptions(this.layoutMode);
        this.network.setOptions(layoutOpts);

        // Re-enable physics for stabilization, then disable
        this.network.once("stabilizationIterationsDone", () => {
            this.network.setOptions({ physics: { enabled: false } });
        });
        this.network.stabilize();
    }

    render(nodesMap, haDevices = {}, haDevicesBySerial = {}) {
        this.haDevices = haDevices;
        this.haDevicesBySerial = haDevicesBySerial;
        this.nodesMap = nodesMap;

        // Categorize devices
        const directDevices = [];  // WiFi only
        const tbrDevices = [];     // Thread Border Routers (Thread + WiFi or is_bridge)
        const threadDevices = [];  // Thread only

        // Build router/REED sets from Thread routing role (0/53/1)
        // Role values: 2=SleepyEndDevice, 3=EndDevice, 4=REED, 5=Router, 6=Leader
        const routerIds = new Set();
        const reedIds = new Set();
        Object.values(nodesMap).forEach(node => {
            const routingRole = node.attributes?.['0/53/1'];
            if (routingRole === 5 || routingRole === 6) {
                routerIds.add(node.node_id);
            } else if (routingRole === 4) {
                reedIds.add(node.node_id);
            }
        });

        // Store neighbor data for graph edges (with signal strength)
        // Format: { fromId: [{ extAddr, rloc16, rssi, lqi, isRouter, isChild }] }
        this.neighborData = {};
        Object.values(nodesMap).forEach(node => {
            const neighbors = node.attributes?.['0/53/7'] || [];
            if (Array.isArray(neighbors)) {
                this.neighborData[node.node_id] = neighbors.map(n => ({
                    extAddr: n['0']?.toString(),
                    rloc16: n['1'],  // RLOC16 - 16-bit address
                    rssi: n['6'],
                    lqi: n['7'],
                    isRouter: n['10'],
                    isChild: n['13']  // true if this neighbor is our child
                }));
            }
        });

        // Categorize nodes
        Object.values(nodesMap).forEach(node => {
            const hasThread = node.attributes?.['0/53/0'] !== undefined;
            const hasWiFi = node.attributes?.['0/54/0'] !== undefined;

            if (node.is_bridge || (hasThread && hasWiFi)) {
                tbrDevices.push(node);
            } else if (hasThread) {
                threadDevices.push(node);
            } else if (hasWiFi) {
                directDevices.push(node);
            } else {
                // Fallback checks
                if (node.attributes?.['0/53/5']) {
                    threadDevices.push(node);
                } else {
                    directDevices.push(node);
                }
            }
        });

        // Sort devices hierarchically: type -> vendor -> model
        directDevices.sort((a, b) => {
            const typeA = this.getDeviceType(a);
            const typeB = this.getDeviceType(b);
            if (typeA !== typeB) return typeA.localeCompare(typeB);

            const vendorA = (a.attributes?.['0/40/1'] || 'ZZZ').toLowerCase();
            const vendorB = (b.attributes?.['0/40/1'] || 'ZZZ').toLowerCase();
            if (vendorA !== vendorB) return vendorA.localeCompare(vendorB);

            const modelA = (a.attributes?.['0/40/14'] || a.attributes?.['0/40/3'] || '').toLowerCase();
            const modelB = (b.attributes?.['0/40/14'] || b.attributes?.['0/40/3'] || '').toLowerCase();
            return modelA.localeCompare(modelB);
        });
        tbrDevices.sort((a, b) => this.getDeviceName(a).localeCompare(this.getDeviceName(b)));

        // Render each section
        this.renderDirectDevices(directDevices);
        // Pass bridges and REEDs - this will also update bridge TBR info
        this.renderThreadMesh(threadDevices, routerIds, reedIds, tbrDevices);
        // Render bridges after thread mesh so we have TBR association info
        this.renderBridges(tbrDevices);
        // Render thread devices list (after thread mesh so roles are available)
        this.renderThreadDevicesList(threadDevices, routerIds, reedIds);
    }

    renderDirectDevices(devices) {
        const container = document.getElementById('direct-devices');
        if (!container) return;

        if (devices.length === 0) {
            container.innerHTML = '<p class="placeholder-text">No direct WiFi devices</p>';
            return;
        }

        // Group by type
        let html = '';
        let currentType = null;

        devices.forEach(node => {
            const name = this.getDeviceName(node);
            const vendor = node.attributes?.['0/40/1'] || 'Unknown';
            const product = node.attributes?.['0/40/14'] || node.attributes?.['0/40/3'] || '';
            const deviceType = this.getDeviceType(node);
            const iconHtml = this.getDeviceIconHtml(deviceType, '#ffffff');

            // Add type header if changed
            if (deviceType !== currentType) {
                currentType = deviceType;
                html += `<div class="device-group-header">${this.getDeviceIconHtml(deviceType, '#f06292')} ${deviceType}s</div>`;
            }

            html += `
                <div class="device-card" data-node-id="${node.node_id}">
                    <div class="device-name"><span class="device-icon">${iconHtml}</span>${this.escapeHtml(name)}</div>
                    <div class="device-info">${this.escapeHtml(vendor)} · ${this.escapeHtml(product)}</div>
                </div>
            `;
        });

        container.innerHTML = html;

        // Add click handlers
        container.querySelectorAll('.device-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('.device-card, .tbr-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const nodeId = parseInt(card.dataset.nodeId);
                this.showNodeDetails(this.nodesMap[nodeId]);
            });
        });
    }

    renderBridges(devices) {
        const container = document.getElementById('bridges-container');
        if (!container) return;

        if (devices.length === 0) {
            container.innerHTML = '<p class="placeholder-text" style="font-size: 0.7rem;">No bridges</p>';
            return;
        }

        let html = '';

        devices.forEach(node => {
            const name = this.getDeviceName(node);
            const vendor = node.attributes?.['0/40/1'] || '';

            // Check if this bridge is also a TBR (Thread Border Router)
            const tbrInfo = this.bridgeTbrInfo?.[node.node_id];
            const isTbr = !!tbrInfo;

            // Find bridged sub-devices by looking for endpoints with Bridged Device Basic Info cluster (57)
            const bridgedDevices = this.getBridgedDevices(node);

            // Build info line
            let infoItems = [];
            if (vendor) infoItems.push(this.escapeHtml(vendor));
            if (isTbr) infoItems.push('TBR');
            if (bridgedDevices.length > 0) infoItems.push(`${bridgedDevices.length} devices`);

            html += `
                <div class="bridge-section">
                    <div class="bridge-card ${isTbr ? 'is-tbr' : ''}" data-node-id="${node.node_id}">
                        <div class="bridge-icon">
                            ${isTbr ? '<i class="fa-solid fa-tower-broadcast"></i>' : '<i class="fa-solid fa-bridge"></i>'}
                        </div>
                        <div class="bridge-name">${this.escapeHtml(name)}</div>
                        <div class="bridge-info">${infoItems.join(' · ')}</div>
                        ${isTbr ? `<div class="tbr-badge">${tbrInfo.seenBy.length} Thread nodes</div>` : ''}
                    </div>
                    ${bridgedDevices.length > 0 ? `
                        <div class="bridged-devices-list">
                            ${this.renderGroupedBridgedDevices(bridgedDevices, node.node_id)}
                        </div>
                    ` : ''}
                </div>
            `;
        });

        container.innerHTML = html;

        // Add click handlers for bridge cards
        container.querySelectorAll('.bridge-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('.device-card, .bridge-card, .bridged-device-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const nodeId = parseInt(card.dataset.nodeId);
                this.showNodeDetails(this.nodesMap[nodeId]);
            });
        });

        // Add click handlers for bridged device cards
        container.querySelectorAll('.bridged-device-card').forEach(card => {
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.device-card, .bridge-card, .bridged-device-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const nodeId = parseInt(card.dataset.nodeId);
                const endpoint = parseInt(card.dataset.endpoint);
                this.showBridgedDeviceDetails(this.nodesMap[nodeId], endpoint);
            });
        });
    }

    renderThreadDevicesList(devices, routerIds, reedIds) {
        const container = document.getElementById('thread-devices');
        if (!container) return;

        if (devices.length === 0) {
            container.innerHTML = '<p class="placeholder-text">No Thread devices</p>';
            return;
        }

        const sorted = [...devices].sort((a, b) => a.node_id - b.node_id);

        let html = '';

        sorted.forEach(node => {
            const name = this.getDeviceName(node);
            const vendor = node.attributes?.['0/40/1'] || 'Unknown';
            const product = node.attributes?.['0/40/14'] || node.attributes?.['0/40/3'] || '';
            const deviceType = this.getDeviceType(node);
            const iconHtml = this.getDeviceIconHtml(deviceType, '#ffffff');

            let role, roleClass;
            if (routerIds.has(node.node_id)) {
                role = 'Router';
                roleClass = 'router';
            } else if (reedIds.has(node.node_id)) {
                role = 'REED';
                roleClass = 'reed';
            } else {
                role = 'End Device';
                roleClass = 'end-device';
            }

            html += `
                <div class="device-card ${node.available ? '' : 'offline'}" data-node-id="${node.node_id}">
                    <div class="device-name">
                        <span class="status-dot ${node.available ? 'online' : 'offline'}"></span>
                        <span class="device-icon">${iconHtml}</span>
                        ${node.node_id} · ${this.escapeHtml(name)}
                        <span class="thread-role-badge ${roleClass}">${role}</span>
                    </div>
                    <div class="device-info">${this.escapeHtml(vendor)} · ${this.escapeHtml(product)}</div>
                </div>
            `;
        });

        container.innerHTML = html;

        // Add click handlers
        container.querySelectorAll('.device-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('.device-card, .bridge-card, .bridged-device-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const nodeId = parseInt(card.dataset.nodeId);
                this.showNodeDetails(this.nodesMap[nodeId]);
                // Also select in graph
                if (this.network) {
                    this.network.selectNodes([nodeId]);
                }
            });
        });
    }

    getBridgedDevices(bridgeNode) {
        const bridgedDevices = [];
        const attrs = bridgeNode.attributes || {};

        // Find all endpoints that have Bridged Device Basic Information cluster (57)
        const endpoints = new Set();
        for (const key of Object.keys(attrs)) {
            const match = key.match(/^(\d+)\/57\//);
            if (match && match[1] !== '0') {
                endpoints.add(parseInt(match[1]));
            }
        }

        endpoints.forEach(endpoint => {
            // Get name from Bridged Device Basic Info: NodeLabel (5) or ProductName (3)
            const nodeLabel = attrs[`${endpoint}/57/5`];
            const productName = attrs[`${endpoint}/57/3`];
            const vendorName = attrs[`${endpoint}/57/1`];

            // Get device type from descriptor cluster
            const deviceTypes = attrs[`${endpoint}/29/0`] || [];
            let deviceType = 'Device';
            if (Array.isArray(deviceTypes) && deviceTypes.length > 0) {
                const typeId = deviceTypes[0]?.['0'] || deviceTypes[0]?.[0];
                deviceType = this.getDeviceTypeNameFromId(typeId) || 'Device';
            }

            // Determine best name
            let name = nodeLabel;
            if (!name || typeof name !== 'string' || !name.trim()) {
                name = productName || `${deviceType} ${endpoint}`;
            }

            bridgedDevices.push({
                endpoint,
                name: name.trim(),
                product: productName || '',
                vendor: vendorName || '',
                deviceType
            });
        });

        // Sort by device type -> vendor -> product -> name
        bridgedDevices.sort((a, b) => {
            if (a.deviceType !== b.deviceType) return a.deviceType.localeCompare(b.deviceType);
            if (a.vendor !== b.vendor) return (a.vendor || 'ZZZ').localeCompare(b.vendor || 'ZZZ');
            if (a.product !== b.product) return (a.product || '').localeCompare(b.product || '');
            return a.name.localeCompare(b.name);
        });

        return bridgedDevices;
    }

    renderGroupedBridgedDevices(devices, bridgeNodeId) {
        let html = '';
        let currentType = null;

        devices.forEach(bd => {
            // Add type header if changed
            if (bd.deviceType !== currentType) {
                currentType = bd.deviceType;
                html += `<div class="bridged-group-header">${this.getDeviceIconHtml(bd.deviceType, '#ba68c8')} ${bd.deviceType}s</div>`;
            }

            html += `
                <div class="bridged-device-card" data-node-id="${bridgeNodeId}" data-endpoint="${bd.endpoint}">
                    <div class="device-name">
                        <span class="device-icon">${this.getDeviceIconHtml(bd.deviceType, '#ce93d8')}</span>
                        ${this.escapeHtml(bd.name)}
                    </div>
                    <div class="device-info">${this.escapeHtml(bd.vendor ? `${bd.vendor} · ${bd.product || bd.deviceType}` : (bd.product || bd.deviceType))}</div>
                </div>
            `;
        });

        return html;
    }

    getDeviceTypeNameFromId(typeId) {
        const deviceTypeNames = {
            256: 'Light', 257: 'Light', 258: 'Light', 259: 'Light', 268: 'Light', 269: 'Light',
            266: 'Outlet', 267: 'Outlet',
            10: 'Lock',
            21: 'Contact Sensor',       // 0x0015 Contact Sensor
            262: 'Light Sensor',        // 0x0106 Light Sensor
            263: 'Motion Sensor',       // 0x0107 Occupancy Sensor
            773: 'Temperature Sensor',  // 0x0305 Temperature Sensor
            775: 'Humidity Sensor',     // 0x0307 Humidity Sensor
            1296: 'Power Sensor',       // 0x0510 Electrical Sensor
            514: 'Window', 515: 'Window',
            770: 'Thermostat',
            14: 'Remote', 15: 'Remote', 17: 'Remote', 19: 'Remote', 772: 'Remote', 2128: 'Remote'
        };
        return deviceTypeNames[typeId];
    }

    showBridgedDeviceDetails(bridgeNode, endpoint) {
        const container = document.getElementById('node-details');
        const attrs = bridgeNode.attributes || {};

        // Get bridged device info from cluster 57
        const nodeLabel = attrs[`${endpoint}/57/5`] || '';
        const productName = attrs[`${endpoint}/57/3`] || '';
        const vendorName = attrs[`${endpoint}/57/1`] || '';
        const serialNumber = attrs[`${endpoint}/57/15`] || '';
        const softwareVersion = attrs[`${endpoint}/57/9`] || '';
        const reachable = attrs[`${endpoint}/57/17`];

        // Get device type
        const deviceTypes = attrs[`${endpoint}/29/0`] || [];
        let deviceTypeName = 'Device';
        if (Array.isArray(deviceTypes) && deviceTypes.length > 0) {
            const typeId = deviceTypes[0]?.['0'] || deviceTypes[0]?.[0];
            deviceTypeName = this.getDeviceTypeNameFromId(typeId) || 'Device';
        }

        const name = nodeLabel || productName || `${deviceTypeName} ${endpoint}`;
        const iconData = this.getDeviceIcon(deviceTypeName);
        const bridgeName = this.getDeviceName(bridgeNode);
        const subtitle = `${vendorName ? vendorName + ' · ' : ''}via ${bridgeName}`;

        let html = `
            <div class="detail-header">
                <div class="detail-header-icon" style="color: #ce93d8;">
                    <i class="fa-solid ${iconData.fa}"></i>
                </div>
                <div class="detail-header-info">
                    <h3>${this.escapeHtml(name)}</h3>
                    <div class="detail-subtitle">${this.escapeHtml(subtitle)}</div>
                </div>
            </div>

            <div class="detail-item">
                <div class="detail-label">Status</div>
                <div class="detail-value ${reachable !== false ? 'status-online' : 'status-offline'}">
                    ${reachable === false ? 'Unreachable' : 'Reachable'}
                </div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Type</div>
                <div class="detail-value">${deviceTypeName}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Endpoint</div>
                <div class="detail-value">${endpoint}</div>
            </div>
        `;

        if (productName && productName !== name) {
            html += `
            <div class="detail-item">
                <div class="detail-label">Product</div>
                <div class="detail-value">${this.escapeHtml(productName)}</div>
            </div>`;
        }

        if (serialNumber) {
            html += `
            <div class="detail-item">
                <div class="detail-label">Serial</div>
                <div class="detail-value"><span class="sensitive">${this.escapeHtml(serialNumber)}</span></div>
            </div>`;
        }

        if (softwareVersion) {
            html += `
            <div class="detail-item">
                <div class="detail-label">Software</div>
                <div class="detail-value">${this.escapeHtml(softwareVersion.toString())}</div>
            </div>`;
        }

        container.innerHTML = html;
    }

    showUnknownNodeDetails(unknown) {
        const container = document.getElementById('node-details');
        const shortAddr = unknown.extAddrHex.slice(0, 4) + '…' + unknown.extAddrHex.slice(-4);
        const roleLabel = unknown.isRouter ? 'Router' : 'End Device';
        const roleIcon = unknown.isRouter ? 'fa-tower-broadcast' : 'fa-microchip';

        // Format ages
        let ageInfo = '';
        if (unknown.ages && unknown.ages.length > 0) {
            const minAge = Math.min(...unknown.ages);
            const maxAge = Math.max(...unknown.ages);
            const formatAge = (s) => {
                if (s < 60) return `${s}s`;
                if (s < 3600) return `${Math.floor(s / 60)}m`;
                return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
            };
            ageInfo = minAge === maxAge ? formatAge(minAge) : `${formatAge(minAge)} - ${formatAge(maxAge)}`;
        }

        let html = `
            <div class="detail-header">
                <div class="detail-header-icon" style="color: #ffb74d;">
                    <i class="fa-solid ${roleIcon}"></i>
                </div>
                <div class="detail-header-info">
                    <h3>Unknown ${roleLabel}</h3>
                    <div class="detail-subtitle"><span class="sensitive">${shortAddr}</span></div>
                </div>
            </div>

            <div class="detail-item">
                <div class="detail-label">Extended Address</div>
                <div class="detail-value mono"><span class="sensitive">${unknown.extAddrHex}</span></div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Role</div>
                <div class="detail-value">${roleLabel}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Last Seen</div>
                <div class="detail-value">${ageInfo || 'Unknown'}</div>
            </div>
        `;

        // Show observers (nodes that see this unknown device)
        if (unknown.seenBy && unknown.seenBy.length > 0) {
            html += `
                <div class="detail-section">
                    <div class="detail-section-title" style="color: #ffb74d;">Observed By (${unknown.seenBy.length})</div>
                    <div class="observer-list">
            `;

            unknown.seenBy.forEach(nodeId => {
                const node = this.nodesMap[nodeId];
                if (!node) return;

                const name = this.getDeviceName(node);
                const neighbors = node.attributes?.['0/53/7'] || [];

                // Find the neighbor entry for this unknown
                let rssi = null;
                let lqi = null;
                let age = null;
                for (const n of neighbors) {
                    try {
                        const upper48 = (BigInt(n['0']) >> 16n).toString();
                        if (upper48 === unknown.upper48) {
                            rssi = n['6'];
                            lqi = n['7'];
                            age = n['2'];
                            break;
                        }
                    } catch (e) {}
                }

                let signalClass = 'signal-weak';
                if (rssi > -70) signalClass = 'signal-strong';
                else if (rssi > -85) signalClass = 'signal-medium';

                html += `
                    <div class="observer-item">
                        <div class="observer-header">
                            <span class="observer-name">${this.escapeHtml(name)}</span>
                            ${rssi !== null ? `<span class="neighbor-signal ${signalClass}">${rssi} dBm</span>` : ''}
                        </div>
                        <div class="observer-details">
                            Node ${nodeId}${lqi !== null ? ` · LQI: ${lqi}` : ''}${age !== null ? ` · Age: ${age}s` : ''}
                        </div>
                    </div>
                `;
            });

            html += `</div></div>`;
        }

        // Possible identification
        html += `
            <div class="detail-section">
                <div class="detail-section-title" style="color: var(--text-muted);">Analysis</div>
                <div class="detail-item">
                    <div class="detail-value" style="font-size: 0.8rem; color: var(--text-muted);">
                        ${unknown.isRouter && unknown.seenBy.length > 5
                            ? 'Likely a Thread Border Router (seen by many devices as a router).'
                            : unknown.isRouter
                                ? 'Unknown router device on the Thread network.'
                                : 'Possibly a stale entry from a device that has left the network.'}
                    </div>
                </div>
            </div>
        `;

        container.innerHTML = html;
    }

    renderThreadMesh(devices, routerIds, reedIds, tbrDevices = []) {
        const nodes = [];
        const edges = [];
        const processedEdges = new Set();
        const deviceNodeIds = new Set(devices.map(d => d.node_id));
        const tbrNodeIds = new Set(tbrDevices.map(d => d.node_id));

        // All Thread-capable devices (for address mapping)
        const allThreadDevices = [...devices, ...tbrDevices];

        // Build extended address -> node_id map
        // Extended address is in General Diagnostics cluster (0x0033 = 51)
        // Attribute NetworkInterfaces (0x0000 = 0)
        // NetworkInterface struct: field 4 = HardwareAddress (base64), field 7 = Type (4=Thread)
        // NOTE: JSON loses precision on 64-bit ints, so we match using upper 48 bits
        this.extAddrToNodeId = {};  // upper48bits -> node_id
        this.rloc16ToNodeId = {};
        this.nodeExtAddrs = {}; // Store for display: node_id -> extAddr
        this.bridgeHwAddrs = {}; // upper48bits -> bridge node_id (for all interfaces)

        // Include TBRs in the address map so we can match neighbors to them
        allThreadDevices.forEach(node => {
            // Get NetworkInterfaces from General Diagnostics cluster
            const networkInterfaces = node.attributes?.['0/51/0'] || [];
            if (Array.isArray(networkInterfaces)) {
                // Find Thread interface (type 7 field = 4) or use first with hardware address
                const threadIface = networkInterfaces.find(i => i['7'] === 4) || networkInterfaces[0];
                if (threadIface) {
                    const hwAddrB64 = threadIface['4']; // HardwareAddress is field 4, base64 encoded
                    if (hwAddrB64) {
                        // Decode base64 to get bytes, then convert to BigInt
                        try {
                            const bytes = atob(hwAddrB64);
                            let extAddrInt = BigInt(0);
                            for (let i = 0; i < bytes.length; i++) {
                                extAddrInt = (extAddrInt << 8n) | BigInt(bytes.charCodeAt(i));
                            }
                            // Use upper 48 bits for matching (JSON precision loses lower 16 bits)
                            const upper48 = (extAddrInt >> 16n).toString();
                            this.extAddrToNodeId[upper48] = node.node_id;
                            this.nodeExtAddrs[node.node_id] = {
                                full: extAddrInt.toString(),
                                upper48: upper48,
                                hex: extAddrInt.toString(16).toUpperCase().padStart(16, '0')
                            };
                        } catch (e) {
                            console.warn('Failed to decode hardware address for node', node.node_id, e);
                        }
                    }
                }

                // For bridges, store ALL hardware addresses so we can match TBR
                // The TBR might use a different interface than the primary Thread one
                if (node.is_bridge) {
                    networkInterfaces.forEach(iface => {
                        const hwAddrB64 = iface['4'];
                        if (hwAddrB64) {
                            try {
                                const bytes = atob(hwAddrB64);
                                let extAddrInt = BigInt(0);
                                for (let i = 0; i < bytes.length; i++) {
                                    extAddrInt = (extAddrInt << 8n) | BigInt(bytes.charCodeAt(i));
                                }
                                const upper48 = (extAddrInt >> 16n).toString();
                                this.bridgeHwAddrs[upper48] = node.node_id;
                            } catch (e) {}
                        }
                    });
                }
            }

            // Also build RLOC16 map from route table for routers
            const routeTable = node.attributes?.['0/53/8'] || [];
            if (Array.isArray(routeTable)) {
                const selfEntry = routeTable.find(r => r['2'] === r['3'] && r['8'] === true);
                if (selfEntry && selfEntry['1'] !== undefined) {
                    this.rloc16ToNodeId[selfEntry['1']] = node.node_id;
                }
            }
        });

        console.log('Extended address map (upper 48 bits):', this.extAddrToNodeId);
        console.log('Node ext addrs:', this.nodeExtAddrs);
        console.log('Bridge hardware addresses:', this.bridgeHwAddrs);

        // Find unknown nodes - addresses seen in neighbor tables that don't match any known node
        // Also track which bridges are acting as TBRs
        const unknownAddrs = new Map(); // upper48 -> { extAddrHex, seenBy: [nodeIds], ages: [], isRouter }
        this.bridgeTbrInfo = {}; // bridge node_id -> { extAddrHex, seenBy: [], ages: [], isRouter }

        devices.forEach(node => {
            const neighbors = this.neighborData[node.node_id] || [];
            neighbors.forEach(neighbor => {
                if (neighbor.extAddr) {
                    try {
                        const extAddrBigInt = BigInt(neighbor.extAddr);
                        const upper48 = (extAddrBigInt >> 16n).toString();
                        const extAddrHex = extAddrBigInt.toString(16).toUpperCase().padStart(16, '0');

                        // Check if this address matches any known node
                        if (!this.extAddrToNodeId[upper48]) {
                            // Check if this matches a bridge's hardware address (TBR association)
                            const matchedBridgeId = this.bridgeHwAddrs[upper48];

                            if (matchedBridgeId) {
                                // This unknown address belongs to a bridge acting as TBR
                                if (!this.bridgeTbrInfo[matchedBridgeId]) {
                                    this.bridgeTbrInfo[matchedBridgeId] = {
                                        extAddrHex: extAddrHex,
                                        upper48: upper48,
                                        seenBy: [],
                                        ages: [],
                                        isRouter: false
                                    };
                                    // Add to extAddr map so edges work
                                    this.extAddrToNodeId[upper48] = matchedBridgeId;
                                }
                                const tbrInfo = this.bridgeTbrInfo[matchedBridgeId];
                                if (!tbrInfo.seenBy.includes(node.node_id)) {
                                    tbrInfo.seenBy.push(node.node_id);
                                }
                                // Track age and router status
                                const rawNeighbor = (node.attributes?.['0/53/7'] || []).find(n => {
                                    try {
                                        return (BigInt(n['0']) >> 16n).toString() === upper48;
                                    } catch (e) { return false; }
                                });
                                if (rawNeighbor) {
                                    const age = rawNeighbor['2'];
                                    if (age !== undefined) {
                                        tbrInfo.ages.push(age);
                                    }
                                    if (rawNeighbor['10']) {
                                        tbrInfo.isRouter = true;
                                    }
                                }
                            } else {
                                // Truly unknown node
                                if (!unknownAddrs.has(upper48)) {
                                    unknownAddrs.set(upper48, {
                                        id: 'unknown_' + upper48,
                                        upper48: upper48,
                                        extAddrHex: extAddrHex,
                                        seenBy: [],
                                        ages: [],
                                        isRouter: false
                                    });
                                }
                                const unknown = unknownAddrs.get(upper48);
                                if (!unknown.seenBy.includes(node.node_id)) {
                                    unknown.seenBy.push(node.node_id);
                                }
                                // Track age from neighbor entry
                                const rawNeighbor = (node.attributes?.['0/53/7'] || []).find(n => {
                                    try {
                                        return (BigInt(n['0']) >> 16n).toString() === upper48;
                                    } catch (e) { return false; }
                                });
                                if (rawNeighbor) {
                                    const age = rawNeighbor['2'];
                                    if (age !== undefined) {
                                        unknown.ages.push(age);
                                    }
                                    if (rawNeighbor['10']) {
                                        unknown.isRouter = true;
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
            });
        });

        // Convert to array and store for edge creation
        this.unknownNodes = Array.from(unknownAddrs.values());
        console.log('Unknown nodes:', this.unknownNodes);
        console.log('Bridge TBR associations:', this.bridgeTbrInfo);

        // Create nodes for Thread devices
        devices.forEach(node => {
            const isRouter = routerIds.has(node.node_id);
            const isReed = reedIds.has(node.node_id);
            const name = this.getDeviceName(node);
            const shortName = name.length > 20 ? name.substring(0, 18) + '…' : name;
            const deviceType = this.getDeviceType(node);
            const iconData = this.getDeviceIcon(deviceType);

            // Color: Router=blue, REED=light blue, EndDevice=teal
            let nodeColor = '#4db6ac';  // end device (teal)
            let nodeSize = 30;
            let group = 'endDevice';

            if (isRouter) {
                nodeColor = '#03a9f4';  // router (blue)
                nodeSize = 40;
                group = 'router';
            } else if (isReed) {
                nodeColor = '#81d4fa';  // REED (light blue)
                nodeSize = 35;
                group = 'reed';
            }

            // Dim offline devices
            if (!node.available) {
                nodeColor = '#78909c';
            }

            const labelText = node.available ? shortName : `${shortName}\n(Offline)`;

            nodes.push({
                id: node.node_id,
                label: labelText,
                group: group,
                mass: isRouter ? 2 : 1,
                title: this.getTooltip(node),
                icon: {
                    face: '"Font Awesome 6 Free"',
                    weight: '900',
                    code: iconData.code,
                    size: nodeSize,
                    color: nodeColor
                },
                font: {
                    size: 10,
                    color: '#ffffff',
                    strokeWidth: 2,
                    strokeColor: '#000000'
                }
            });
        });

        // Create nodes for unknown devices - auto-arranged with question mark icon
        this.unknownNodes.forEach((unknown, index) => {
            const shortAddr = unknown.extAddrHex.slice(0, 4) + '…' + unknown.extAddrHex.slice(-4);
            nodes.push({
                id: unknown.id,
                label: this.anonymized ? 'Unknown' : shortAddr,
                shape: 'icon',
                icon: {
                    face: '"Font Awesome 6 Free"',
                    weight: '900',
                    code: '\uf128',  // question mark
                    size: unknown.isRouter ? 35 : 25,
                    color: '#ff9800'
                },
                font: {
                    size: 9,
                    color: '#ffb74d',
                    strokeWidth: 2,
                    strokeColor: '#000000'
                },
                title: this.anonymized ? 'Unknown Device' : ('Unknown: ' + unknown.extAddrHex + (unknown.isRouter ? ' (Router)' : ' (End Device)'))
            });
        });

        // Create nodes for bridges that are TBRs (Thread Border Routers)
        Object.entries(this.bridgeTbrInfo || {}).forEach(([nodeIdStr, tbrInfo]) => {
            const nodeId = parseInt(nodeIdStr);
            const bridgeNode = this.nodesMap[nodeId];
            if (!bridgeNode) return;

            const name = this.getDeviceName(bridgeNode);
            const shortName = name.length > 15 ? name.substring(0, 13) + '…' : name;

            nodes.push({
                id: nodeId,
                label: shortName,
                group: 'tbr',
                mass: 3, // Higher mass pulls TBRs toward center
                title: `${name}\nThread Border Router\nSeen by ${tbrInfo.seenBy.length} nodes`,
                icon: {
                    face: '"Font Awesome 6 Free"',
                    weight: '900',
                    code: '\uf519',  // tower-broadcast
                    size: 40,
                    color: '#4fc3f7'  // Light blue for TBR
                },
                font: {
                    size: 10,
                    color: '#ffffff',
                    strokeWidth: 2,
                    strokeColor: '#000000'
                }
            });
        });

        // Build map of unknown node upper48 -> id for edge creation
        const unknownAddrToId = {};
        this.unknownNodes.forEach(u => {
            unknownAddrToId[u.upper48] = u.id;
        });

        // Create edges from neighbor tables using extended address matching
        // Use upper 48 bits due to JSON precision loss on 64-bit integers
        devices.forEach(node => {
            const neighbors = this.neighborData[node.node_id] || [];

            neighbors.forEach(neighbor => {
                const rssi = neighbor.rssi ?? -100;
                const neighborExtAddr = neighbor.extAddr;

                // Find target node by extended address upper 48 bits
                let targetNodeId = null;
                let isUnknown = false;
                if (neighborExtAddr) {
                    try {
                        const upper48 = (BigInt(neighborExtAddr) >> 16n).toString();
                        targetNodeId = this.extAddrToNodeId[upper48];

                        // If not found in known nodes, check unknown nodes
                        if (!targetNodeId && unknownAddrToId[upper48]) {
                            targetNodeId = unknownAddrToId[upper48];
                            isUnknown = true;
                        }
                    } catch (e) {
                        // Invalid address format
                    }
                }

                // Allow edges to Thread devices, TBRs, or unknown nodes
                const isValidTarget = targetNodeId && (
                    deviceNodeIds.has(targetNodeId) ||
                    tbrNodeIds.has(targetNodeId) ||
                    isUnknown
                );

                if (isValidTarget && targetNodeId !== node.node_id) {
                    const edgeId = [node.node_id, targetNodeId].sort().join('-');
                    if (!processedEdges.has(edgeId)) {
                        // Color based on signal strength
                        let color;
                        if (rssi > -70) {
                            color = 'rgba(76, 175, 80, 0.7)';  // Green - strong
                        } else if (rssi > -85) {
                            color = 'rgba(255, 152, 0, 0.7)'; // Orange - medium
                        } else {
                            color = 'rgba(244, 67, 54, 0.5)'; // Red - weak
                        }

                        edges.push({
                            from: node.node_id,
                            to: targetNodeId,
                            width: Math.max(1, Math.min(4, (rssi + 100) / 15)),
                            color: { color: color, highlight: color }
                        });
                        processedEdges.add(edgeId);
                    }
                }
            });
        });

        // Connect end devices to their parent routers via extended address
        devices.forEach(endDevice => {
            if (routerIds.has(endDevice.node_id)) return; // Skip routers

            const neighbors = this.neighborData[endDevice.node_id] || [];
            if (neighbors.length > 0) {
                // Find the best signal neighbor that is a router
                const routerNeighbor = neighbors
                    .filter(n => n.isRouter)
                    .sort((a, b) => (b.rssi ?? -100) - (a.rssi ?? -100))[0];

                if (routerNeighbor && routerNeighbor.extAddr) {
                    // Use upper 48 bits for matching
                    let parentNodeId = null;
                    let isUnknownParent = false;
                    try {
                        const upper48 = (BigInt(routerNeighbor.extAddr) >> 16n).toString();
                        parentNodeId = this.extAddrToNodeId[upper48];
                        if (!parentNodeId && unknownAddrToId[upper48]) {
                            parentNodeId = unknownAddrToId[upper48];
                            isUnknownParent = true;
                        }
                    } catch (e) {}

                    const isValidParent = parentNodeId && (
                        deviceNodeIds.has(parentNodeId) ||
                        tbrNodeIds.has(parentNodeId) ||
                        isUnknownParent
                    );

                    if (isValidParent) {
                        const edgeId = [endDevice.node_id, parentNodeId].sort().join('-');
                        if (!processedEdges.has(edgeId)) {
                            const rssi = routerNeighbor.rssi ?? -100;
                            let color;
                            if (rssi > -70) {
                                color = 'rgba(76, 175, 80, 0.7)';
                            } else if (rssi > -85) {
                                color = 'rgba(255, 152, 0, 0.7)';
                            } else {
                                color = 'rgba(244, 67, 54, 0.5)';
                            }

                            edges.push({
                                from: endDevice.node_id,
                                to: parentNodeId,
                                width: Math.max(1, Math.min(4, (rssi + 100) / 15)),
                                color: { color: color, highlight: color },
                                dashes: true  // Dashed line for end device connections
                            });
                            processedEdges.add(edgeId);
                        }
                    }
                }
            }
        });

        if (!this.network) {
            // First render: add all nodes/edges and create the network
            this.data.nodes.add(nodes);
            this.data.edges.add(edges);

            // Merge layout-specific options
            const layoutOpts = this.getLayoutOptions(this.layoutMode);
            const opts = { ...this.options, ...layoutOpts };
            this.network = new vis.Network(this.container, this.data, opts);

            // Disable physics after stabilization to stop spinning
            this.network.on("stabilizationIterationsDone", () => {
                this.network.setOptions({ physics: { enabled: false } });
            });

            this.network.on("click", (params) => {
                document.querySelectorAll('.device-card, .bridge-card, .bridged-device-card').forEach(c => c.classList.remove('selected'));

                if (params.nodes.length > 0) {
                    const nodeId = params.nodes[0];

                    // Check if it's an unknown node (id starts with 'unknown_')
                    if (typeof nodeId === 'string' && nodeId.startsWith('unknown_')) {
                        const unknown = this.unknownNodes?.find(u => u.id === nodeId);
                        if (unknown) {
                            this.showUnknownNodeDetails(unknown);
                        }
                    } else {
                        // Regular node
                        const nodeData = this.nodesMap[nodeId];
                        if (nodeData) {
                            this.showNodeDetails(nodeData);
                            // Also highlight the card if exists
                            const card = document.querySelector(`.device-card[data-node-id="${nodeId}"], .bridge-card[data-node-id="${nodeId}"]`);
                            if (card) {
                                card.classList.add('selected');
                                card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            }
                        }
                    }
                } else {
                    document.getElementById('node-details').innerHTML = '<p class="placeholder-text">Select a node to view details</p>';
                }
            });

        } else {
            // Incremental update: preserve existing node positions
            const positions = this.network.getPositions();

            // Build maps of current and new nodes/edges for diffing
            const currentNodeIds = new Set(this.data.nodes.getIds());
            const newNodeIds = new Set(nodes.map(n => n.id));
            const currentEdgeIds = new Set(this.data.edges.getIds());
            const newEdgeMap = {};
            edges.forEach(e => {
                const eid = [e.from, e.to].sort().join('-');
                newEdgeMap[eid] = e;
            });

            // Remove nodes that no longer exist
            const toRemove = [...currentNodeIds].filter(id => !newNodeIds.has(id));
            if (toRemove.length > 0) {
                this.data.nodes.remove(toRemove);
            }

            // Update existing nodes (preserve position) and add new ones
            const toUpdate = [];
            const toAdd = [];
            nodes.forEach(node => {
                if (currentNodeIds.has(node.id)) {
                    // Preserve x/y position from current layout
                    const pos = positions[node.id];
                    if (pos) {
                        node.x = pos.x;
                        node.y = pos.y;
                    }
                    toUpdate.push(node);
                } else {
                    toAdd.push(node);
                }
            });

            if (toUpdate.length > 0) {
                this.data.nodes.update(toUpdate);
            }
            if (toAdd.length > 0) {
                this.data.nodes.add(toAdd);
                // Briefly enable physics to position new nodes, then disable
                if (toAdd.length > 0) {
                    this.network.setOptions({ physics: { enabled: true } });
                    this.network.once("stabilizationIterationsDone", () => {
                        this.network.setOptions({ physics: { enabled: false } });
                    });
                }
            }

            // Rebuild edges (simpler since they don't have positions)
            this.data.edges.clear();
            this.data.edges.add(edges);
        }
    }

    getDeviceName(node) {
        // Priority: 1. HA friendly name, 2. Matter user label, 3. Product name
        const haDevice = this.getHADevice(node);
        if (haDevice?.friendly_name) {
            return haDevice.friendly_name;
        }

        const userLabel = node.attributes?.['0/40/5'];
        if (userLabel && typeof userLabel === 'string' && userLabel.trim() && !userLabel.includes('\0')) {
            return userLabel;
        }

        return node.attributes?.['0/40/14'] || node.attributes?.['0/40/3'] || `Device ${node.node_id}`;
    }

    getHADevice(node) {
        if (this.haDevices?.[node.node_id]) {
            return this.haDevices[node.node_id];
        }
        const serial = node.attributes?.['0/40/15'];
        if (serial && this.haDevicesBySerial?.[serial]) {
            return this.haDevicesBySerial[serial];
        }
        return null;
    }

    // Device type icons mapping (Font Awesome)
    deviceTypeIcons = {
        'Light': { fa: 'fa-lightbulb', code: '\uf0eb' },
        'Outlet': { fa: 'fa-plug', code: '\uf1e6' },
        'Switch': { fa: 'fa-toggle-on', code: '\uf205' },
        'Window': { fa: 'fa-window-maximize', code: '\uf2d0' },
        'Lock': { fa: 'fa-lock', code: '\uf023' },
        'Thermostat': { fa: 'fa-temperature-half', code: '\uf2c9' },
        'Sensor': { fa: 'fa-eye', code: '\uf06e' },
        'Contact Sensor': { fa: 'fa-door-open', code: '\uf52b' },
        'Motion Sensor': { fa: 'fa-street-view', code: '\uf21d' },
        'Temperature Sensor': { fa: 'fa-thermometer-half', code: '\uf2c9' },
        'Humidity Sensor': { fa: 'fa-droplet', code: '\uf043' },
        'Light Sensor': { fa: 'fa-sun', code: '\uf185' },
        'Power Sensor': { fa: 'fa-bolt', code: '\uf0e7' },
        'Remote': { fa: 'fa-gamepad', code: '\uf11b' },
        'Pump': { fa: 'fa-faucet-drip', code: '\ue006' },
        'Device': { fa: 'fa-cube', code: '\uf1b2' },
        'TBR': { fa: 'fa-globe', code: '\uf0ac' }
    };

    getDeviceIcon(type) {
        return this.deviceTypeIcons[type] || this.deviceTypeIcons['Device'];
    }

    getDeviceIconHtml(type, color = 'currentColor') {
        const icon = this.getDeviceIcon(type);
        return `<i class="fa-solid ${icon.fa}" style="color: ${color}"></i>`;
    }

    getDeviceType(node) {
        // Matter device type IDs (from spec)
        // https://github.com/project-chip/connectedhomeip/blob/master/src/app/zap-templates/zcl/data-model/chip/matter-devices.xml
        const deviceTypeNames = {
            // Lights (0x0100-0x010D)
            256: 'Light',      // 0x0100 On/Off Light
            257: 'Light',      // 0x0101 Dimmable Light
            258: 'Light',      // 0x0102 Color Temperature Light
            259: 'Light',      // 0x0103 Extended Color Light
            268: 'Light',      // 0x010C Color Temperature Light
            269: 'Light',      // 0x010D Extended Color Light
            // Outlets/Plugs
            266: 'Outlet',     // 0x010A On/Off Plug-in Unit
            267: 'Outlet',     // 0x010B Dimmable Plug-In Unit
            // Locks
            10: 'Lock',        // 0x000A Door Lock
            // Sensors - CORRECTED IDs
            21: 'Contact Sensor',       // 0x0015 Contact Sensor
            262: 'Light Sensor',        // 0x0106 Light Sensor
            263: 'Motion Sensor',       // 0x0107 Occupancy Sensor - THIS WAS WRONG!
            773: 'Temperature Sensor',  // 0x0305 Temperature Sensor
            775: 'Humidity Sensor',     // 0x0307 Humidity Sensor
            1296: 'Power Sensor',       // 0x0510 Electrical Sensor
            // Window Coverings
            514: 'Window',     // 0x0202 Window Covering
            515: 'Window',     // 0x0203 Window Covering Controller
            // Climate
            770: 'Thermostat', // 0x0302 Thermostat
            // Remotes/Controls
            14: 'Remote',      // Aggregator
            15: 'Remote',      // Generic Switch
            17: 'Remote',      // Power Source
            19: 'Remote',      // Bridge
            772: 'Remote',     // Basic Video Player
            2128: 'Remote',    // Control Bridge
        };

        // Priority types - these should win if present (primary function)
        const priorityTypes = [263, 21, 10, 770]; // Occupancy/Motion, Contact, Lock, Thermostat

        // Check all endpoints for device types
        const attrs = node.attributes || {};
        let foundTypes = [];

        for (const key of Object.keys(attrs)) {
            // Look for device type descriptors (endpoint/29/0)
            const match = key.match(/^(\d+)\/29\/0$/);
            if (match && match[1] !== '0') {  // Skip root endpoint 0
                const deviceTypes = attrs[key];
                if (Array.isArray(deviceTypes)) {
                    for (const dt of deviceTypes) {
                        const typeId = dt['0'] || dt[0];
                        if (typeId && deviceTypeNames[typeId]) {
                            foundTypes.push(typeId);
                        }
                    }
                }
            }
        }

        // Check for priority types first
        for (const priorityId of priorityTypes) {
            if (foundTypes.includes(priorityId)) {
                return deviceTypeNames[priorityId];
            }
        }

        // Return first found type
        if (foundTypes.length > 0) {
            return deviceTypeNames[foundTypes[0]];
        }

        // Fallback: check clusters on all endpoints (prioritize motion/contact)
        let hasMotion = false, hasContact = false, hasTemp = false, hasHumidity = false;

        for (const key of Object.keys(attrs)) {
            const match = key.match(/^(\d+)\/29\/1$/);
            if (match) {
                const clusters = attrs[key] || [];
                if (clusters.includes(768)) return 'Light';  // Color Control
                if (clusters.includes(8)) return 'Light';    // Level Control
                if (clusters.includes(6)) return 'Switch';   // On/Off
                if (clusters.includes(258)) return 'Window'; // Window Covering
                if (clusters.includes(257)) return 'Lock';   // Door Lock
                if (clusters.includes(1030)) hasMotion = true;   // Occupancy
                if (clusters.includes(69)) hasContact = true;    // Boolean State
                if (clusters.includes(1026)) hasTemp = true;     // Temperature
                if (clusters.includes(1029)) hasHumidity = true; // Humidity
            }
        }

        // Return sensor types in priority order
        if (hasMotion) return 'Motion Sensor';
        if (hasContact) return 'Contact Sensor';
        if (hasTemp) return 'Temperature Sensor';
        if (hasHumidity) return 'Humidity Sensor';

        return 'Device';
    }

    setAnonymized(active) {
        this.anonymized = active;
        // Update all graph node tooltips
        if (this.data?.nodes) {
            const updates = [];
            this.data.nodes.forEach(n => {
                if (typeof n.id === 'string' && n.id.startsWith('unknown_')) {
                    const unknown = this.unknownNodes?.find(u => u.id === n.id);
                    updates.push({
                        id: n.id,
                        title: active ? 'Unknown Device' : ('Unknown: ' + (unknown?.extAddrHex || '') + (unknown?.isRouter ? ' (Router)' : ' (End Device)')),
                        label: active ? 'Unknown' : (unknown ? unknown.extAddrHex.slice(0, 4) + '…' + unknown.extAddrHex.slice(-4) : n.label)
                    });
                } else {
                    const node = this.nodesMap[n.id];
                    if (node) {
                        updates.push({ id: n.id, title: active ? '' : this.getTooltip(node) });
                    }
                }
            });
            this.data.nodes.update(updates);
        }
    }

    getTooltip(node) {
        const name = this.getDeviceName(node);
        const vendor = node.attributes?.['0/40/1'] || 'N/A';
        const status = node.available ? 'Online' : 'Offline';
        if (this.anonymized) return '';
        return `${name}\nNode ID: ${node.node_id}\nVendor: ${vendor}\nStatus: ${status}`;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    showNodeDetails(node) {
        const container = document.getElementById('node-details');
        const haDevice = this.getHADevice(node);
        const hasThread = node.attributes?.['0/53/0'] !== undefined;
        const hasWiFi = node.attributes?.['0/54/0'] !== undefined;
        const name = this.getDeviceName(node);
        const deviceType = this.getDeviceType(node);
        const iconData = this.getDeviceIcon(deviceType);

        let connectionType = 'Unknown';
        let iconColor = 'var(--text-muted)';
        if (node.is_bridge || (hasThread && hasWiFi)) {
            connectionType = 'Bridge';
            iconColor = '#ce93d8';
        } else if (hasThread) {
            connectionType = 'Thread';
            iconColor = '#03a9f4';
        } else if (hasWiFi) {
            connectionType = 'WiFi';
            iconColor = '#4fc3f7';
        }

        // Thread role
        const threadRole = node.attributes?.['0/53/1'];
        const roleNames = { 2: 'Sleepy End Device', 3: 'End Device', 4: 'REED', 5: 'Router', 6: 'Leader' };
        const roleName = roleNames[threadRole] || '';

        const vendor = node.attributes?.['0/40/1'] || '';
        const subtitle = `${connectionType}${roleName ? ` · ${roleName}` : ''}${vendor ? ` · ${vendor}` : ''}`;

        let html = `
            <div class="detail-header">
                <div class="detail-header-icon" style="color: ${iconColor};">
                    <i class="fa-solid ${iconData.fa}"></i>
                </div>
                <div class="detail-header-info">
                    <h3>${this.escapeHtml(name)}</h3>
                    <div class="detail-subtitle">${subtitle}</div>
                </div>
            </div>

            <div class="detail-item">
                <div class="detail-label">Status</div>
                <div class="detail-value ${node.available ? 'status-online' : 'status-offline'}">
                    ${node.available ? 'Online' : 'Offline'}
                </div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Node ID</div>
                <div class="detail-value"><span class="sensitive">${node.node_id}</span></div>
            </div>
        `;

        const basicInfo = {
            'Model': '0/40/3',
            'Product': '0/40/14',
            'Firmware': '0/40/8',
            'Serial': '0/40/15'
        };

        const sensitiveLabels = new Set(['Serial']);

        for (const [label, path] of Object.entries(basicInfo)) {
            const val = node.attributes?.[path];
            if (val && val.toString().trim()) {
                const escaped = this.escapeHtml(val.toString());
                const value = sensitiveLabels.has(label) ? `<span class="sensitive">${escaped}</span>` : escaped;
                html += `
                    <div class="detail-item">
                        <div class="detail-label">${label}</div>
                        <div class="detail-value">${value}</div>
                    </div>
                `;
            }
        }

        // Thread Addresses
        if (hasThread) {
            // Get extended address from our pre-built map
            const extAddrInfo = this.nodeExtAddrs?.[node.node_id];
            const ownExtAddrHex = extAddrInfo?.hex;

            // Find own RLOC16 from route table (routerId == nextHop entry)
            const routeTable = node.attributes?.['0/53/8'] || [];
            let ownRloc16 = null;
            if (Array.isArray(routeTable)) {
                const selfEntry = routeTable.find(r => r['2'] === r['3'] && r['8'] === true);
                if (selfEntry) {
                    ownRloc16 = selfEntry['1'];
                }
            }

            const channel = node.attributes?.['0/53/0'];
            const networkName = node.attributes?.['0/53/3'];
            const panId = node.attributes?.['0/53/4'];
            const extPanId = node.attributes?.['0/53/5'];

            html += `<div class="detail-section">
                <div class="detail-section-title">Thread Addresses</div>`;

            if (ownRloc16 !== null) {
                html += `<div class="detail-item">
                    <div class="detail-label">RLOC16</div>
                    <div class="detail-value" style="font-family: monospace;"><span class="sensitive">0x${ownRloc16.toString(16).toUpperCase().padStart(4, '0')}</span></div>
                </div>`;
            }

            if (ownExtAddrHex) {
                html += `<div class="detail-item">
                    <div class="detail-label">Extended Address</div>
                    <div class="detail-value" style="font-family: monospace; font-size: 0.8rem;"><span class="sensitive">${ownExtAddrHex}</span></div>
                </div>`;
            }

            if (channel !== undefined) {
                html += `<div class="detail-item">
                    <div class="detail-label">Channel</div>
                    <div class="detail-value">${channel}</div>
                </div>`;
            }

            if (networkName) {
                html += `<div class="detail-item">
                    <div class="detail-label">Network</div>
                    <div class="detail-value"><span class="sensitive">${this.escapeHtml(networkName)}</span></div>
                </div>`;
            }

            if (panId !== undefined) {
                html += `<div class="detail-item">
                    <div class="detail-label">PAN ID</div>
                    <div class="detail-value" style="font-family: monospace;"><span class="sensitive">0x${panId.toString(16).toUpperCase().padStart(4, '0')}</span></div>
                </div>`;
            }

            html += `</div>`;
        }

        // Thread Neighbor Table
        if (hasThread) {
            const neighbors = node.attributes?.['0/53/7'] || [];

            // Find nodes that observe this node (have this node in their neighbor table)
            const observers = this.getObserversOfNode(node.node_id);

            // Calculate actual connection count (union of neighbors and observers)
            const neighborExtAddrs = new Set();
            neighbors.forEach(n => {
                if (n['0']) {
                    try {
                        const upper48 = (BigInt(n['0']) >> 16n).toString();
                        neighborExtAddrs.add(upper48);
                    } catch (e) {}
                }
            });
            const observerNodeIds = new Set(observers.map(o => o.nodeId));
            const myExtAddr = this.nodeExtAddrs?.[node.node_id]?.upper48;

            // Total unique connections
            const allConnectedIds = new Set();
            neighbors.forEach(n => {
                if (n['0']) {
                    try {
                        const upper48 = (BigInt(n['0']) >> 16n).toString();
                        const resolvedId = this.extAddrToNodeId?.[upper48];
                        if (resolvedId) allConnectedIds.add(resolvedId);
                    } catch (e) {}
                }
            });
            observers.forEach(o => allConnectedIds.add(o.nodeId));

            if (Array.isArray(neighbors) && neighbors.length > 0) {
                html += `
                    <div class="detail-section">
                        <div class="detail-section-title">Neighbors (${neighbors.length})</div>
                `;
                // Sort by RSSI (best signal first)
                const sortedNeighbors = [...neighbors].sort((a, b) => (b['6'] || -999) - (a['6'] || -999));
                sortedNeighbors.forEach(n => {
                    const rssi = n['6'] ?? 'N/A';
                    const lqi = n['7'] ?? 'N/A';
                    const isRouter = n['10'];
                    const rxOnIdle = n['11'];
                    const fullThread = n['12'];
                    const isChild = n['13'];
                    const rloc16Raw = n['1'];
                    const rloc16 = rloc16Raw?.toString(16).toUpperCase().padStart(4, '0') || '?';
                    const age = n['2'] ?? 0;

                    // Get extended address and convert to hex for display
                    const extAddr = n['0'];
                    let extAddrHex = '';
                    let resolvedName = '';
                    let resolvedNodeId = null;

                    if (extAddr) {
                        try {
                            extAddrHex = BigInt(extAddr).toString(16).toUpperCase().padStart(16, '0');
                            const upper48 = (BigInt(extAddr) >> 16n).toString();
                            resolvedNodeId = this.extAddrToNodeId?.[upper48];
                            if (resolvedNodeId && this.nodesMap[resolvedNodeId]) {
                                resolvedName = this.getDeviceName(this.nodesMap[resolvedNodeId]);
                            }
                        } catch (e) {}
                    }

                    let signalClass = 'signal-weak';
                    if (rssi > -70) signalClass = 'signal-strong';
                    else if (rssi > -85) signalClass = 'signal-medium';

                    const typeIcon = isRouter ? '🔷' : '🔹';
                    const sleepIcon = rxOnIdle ? '' : ' 💤';

                    html += `
                        <div class="neighbor-item">
                            <div class="neighbor-header">
                                <span class="neighbor-type">${typeIcon}</span>
                                <span class="neighbor-addr"><span class="sensitive">${extAddrHex.slice(0, 4)}…${extAddrHex.slice(-4)}</span></span>
                                <span class="neighbor-signal ${signalClass}">${rssi} dBm</span>
                            </div>
                            <div class="neighbor-details">
                                ${resolvedName ? `<strong>${this.escapeHtml(resolvedName)}</strong> · ` : ''}LQI: ${lqi} · Age: ${age}s${isChild ? ' · Child' : ''}${fullThread ? ' · FTD' : ' · MTD'}${sleepIcon}
                            </div>
                        </div>
                    `;
                });
                html += `</div>`;
            }

            // Thread Route Table
            const routes = node.attributes?.['0/53/8'] || [];
            if (Array.isArray(routes) && routes.length > 0) {
                html += `
                    <div class="detail-section">
                        <div class="detail-section-title">Routes (${routes.length})</div>
                `;
                routes.forEach(r => {
                    const routerId = r['2'] ?? '?';
                    const nextHop = r['3'] ?? '?';
                    const pathCost = r['4'] ?? '?';
                    const lqIn = r['5'] ?? '?';
                    const lqOut = r['6'] ?? '?';
                    const rloc16 = r['1']?.toString(16).toUpperCase().padStart(4, '0') || '?';

                    html += `
                        <div class="route-item">
                            <div class="route-header">
                                <span class="route-id">Router ${routerId}</span>
                                <span class="route-rloc"><span class="sensitive">${rloc16}</span></span>
                            </div>
                            <div class="route-details">
                                Next: ${nextHop} · Cost: ${pathCost} · LQ: ${lqIn}/${lqOut}
                            </div>
                        </div>
                    `;
                });
                html += `</div>`;
            }

            // Show observers (nodes that see this node but aren't in our neighbor table)
            if (observers.length > 0) {
                // Filter to only show observers NOT already in our neighbor table
                const observersNotInNeighbors = observers.filter(o => {
                    const observerExtAddr = this.nodeExtAddrs?.[o.nodeId]?.upper48;
                    return observerExtAddr && !neighborExtAddrs.has(observerExtAddr);
                });

                if (observersNotInNeighbors.length > 0) {
                    html += `
                        <div class="detail-section">
                            <div class="detail-section-title" style="color: #ffb74d;">Also Connected (${observersNotInNeighbors.length})</div>
                            <div class="observer-list">
                    `;

                    observersNotInNeighbors.forEach(obs => {
                        const observerNode = this.nodesMap[obs.nodeId];
                        if (!observerNode) return;

                        const obsName = this.getDeviceName(observerNode);
                        const rssi = obs.rssi;
                        const lqi = obs.lqi;
                        const age = obs.age;

                        let signalClass = 'signal-weak';
                        if (rssi > -70) signalClass = 'signal-strong';
                        else if (rssi > -85) signalClass = 'signal-medium';

                        html += `
                            <div class="observer-item">
                                <div class="observer-header">
                                    <span class="observer-name">${this.escapeHtml(obsName)}</span>
                                    ${rssi !== null ? `<span class="neighbor-signal ${signalClass}">${rssi} dBm</span>` : ''}
                                </div>
                                <div class="observer-details">
                                    Node ${obs.nodeId}${lqi !== null ? ` · LQI: ${lqi}` : ''}${age !== null ? ` · Age: ${age}s` : ''} · sees us
                                </div>
                            </div>
                        `;
                    });

                    html += `</div></div>`;
                }
            }
        }

        container.innerHTML = html;
    }

    // Find all nodes that have the given nodeId in their neighbor table
    getObserversOfNode(targetNodeId) {
        const observers = [];
        const targetExtAddr = this.nodeExtAddrs?.[targetNodeId]?.upper48;

        if (!targetExtAddr) return observers;

        // Search all nodes' neighbor tables for this node's extended address
        Object.entries(this.nodesMap).forEach(([nodeIdStr, node]) => {
            const nodeId = parseInt(nodeIdStr);
            if (nodeId === targetNodeId) return; // Skip self

            const neighbors = node.attributes?.['0/53/7'] || [];
            if (!Array.isArray(neighbors)) return;

            for (const n of neighbors) {
                if (n['0']) {
                    try {
                        const upper48 = (BigInt(n['0']) >> 16n).toString();
                        if (upper48 === targetExtAddr) {
                            observers.push({
                                nodeId: nodeId,
                                rssi: n['6'] ?? null,
                                lqi: n['7'] ?? null,
                                age: n['2'] ?? null
                            });
                            break;
                        }
                    } catch (e) {}
                }
            }
        });

        // Sort by signal strength
        observers.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
        return observers;
    }
}
