// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

interface FileChangeRecord {
    filePath: string;
    content: string;
    timestamp: number;
    changeType: 'created' | 'modified' | 'deleted';
}

function uint8ArrayToString(uint8Array: Uint8Array): string {
    try {
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(uint8Array);
    } catch (error) {
        return Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 File change listener extension loaded');

    let hiddenStorageWebview: vscode.WebviewPanel | undefined = undefined;
    let isStorageReady = false;
    let fileWatcher: vscode.FileSystemWatcher | undefined = undefined;
    let isExtensionRunning = false;
    let pendingFiles: FileChangeRecord[] = [];
    let webviewClosed = false;
    let storedFiles: FileChangeRecord[] = [];

    // MAIN COMMAND: Start the extension
    const startExtensionCommand = vscode.commands.registerCommand('file-change-listener.start', async () => {
        if (isExtensionRunning) {
            vscode.window.showInformationMessage('File change listener is already running!');
            return;
        }

        console.log('🚀 Starting file change listener...');
        webviewClosed = false;
        await startFileChangeListener();
    });

    // Command to stop the extension
    const stopExtensionCommand = vscode.commands.registerCommand('file-change-listener.stop', () => {
        if (!isExtensionRunning) {
            vscode.window.showInformationMessage('File change listener is not running');
            return;
        }

        stopFileChangeListener();
        vscode.window.showInformationMessage('File change listener stopped');
    });

    // Command to get stored files
    const getStoredFilesCommand = vscode.commands.registerCommand('file-change-listener.getStoredFiles', async () => {
        if (!isExtensionRunning) {
            vscode.window.showWarningMessage('Extension not running. Start it first.');
            return;
        }

        if (hiddenStorageWebview && isStorageReady && !webviewClosed) {
            hiddenStorageWebview.webview.postMessage({ type: 'getAllFiles' });
        } else if (storedFiles.length > 0) {
            displayRetrievedFiles(storedFiles);
            vscode.window.showInformationMessage(
                `Showing ${storedFiles.length} cached files (localStorage unavailable)`
            );
        } else {
            vscode.window.showWarningMessage('No files available');
        }
    });

    // Command to get storage info
    const getStorageInfoCommand = vscode.commands.registerCommand('file-change-listener.getStorageInfo', async () => {
        if (!isExtensionRunning) {
            vscode.window.showWarningMessage('Extension not running');
            return;
        }

        if (hiddenStorageWebview && isStorageReady && !webviewClosed) {
            hiddenStorageWebview.webview.postMessage({ type: 'getStorageInfo' });
        } else {
            const totalSize = storedFiles.reduce((sum, file) => sum + file.content.length, 0);
            const lastActivity = storedFiles.length > 0 ? 
                new Date(Math.max(...storedFiles.map(f => f.timestamp))).toLocaleString() : 'Never';
            
            vscode.window.showInformationMessage(
                `📊 Cached: ${storedFiles.length} files, ${Math.round(totalSize / 1024)} KB, Last: ${lastActivity}`
            );
        }
    });

    // Command to export data
    const exportDataCommand = vscode.commands.registerCommand('file-change-listener.exportData', async () => {
        if (!isExtensionRunning) {
            vscode.window.showWarningMessage('Extension not running');
            return;
        }

        if (hiddenStorageWebview && isStorageReady && !webviewClosed) {
            hiddenStorageWebview.webview.postMessage({ type: 'exportData' });
        } else if (storedFiles.length > 0) {
            exportCachedFiles();
        } else {
            vscode.window.showWarningMessage('No files to export');
        }
    });

    // Start the file change listener
    async function startFileChangeListener() {
        if (isExtensionRunning) return;

        try {
            if (!webviewClosed) {
                await createEmbeddedHiddenWebview();
            } else {
                console.log('📝 Starting without webview (was previously closed)');
                vscode.window.showInformationMessage(
                    '⚠️ Starting with memory cache only (localStorage was closed)',
                    'Enable localStorage'
                ).then((selection) => {
                    if (selection === 'Enable localStorage') {
                        webviewClosed = false;
                        createEmbeddedHiddenWebview().catch(console.error);
                    }
                });
            }
            
            // Start file watcher
            fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
            
            fileWatcher.onDidCreate(async (uri) => {
                await handleFileChange(uri, 'created');
            });

            fileWatcher.onDidChange(async (uri) => {
                await handleFileChange(uri, 'modified');
            });

            fileWatcher.onDidDelete(async (uri) => {
                await handleFileChange(uri, 'deleted');
            });

            isExtensionRunning = true;
            console.log('✅ File change listener started');
            
        } catch (error) {
            console.error('❌ Error starting file change listener:', error);
            vscode.window.showErrorMessage('Failed to start: ' + error);
        }
    }

    // Stop the file change listener
    function stopFileChangeListener() {
        if (fileWatcher) {
            fileWatcher.dispose();
            fileWatcher = undefined;
        }

        if (hiddenStorageWebview) {
            hiddenStorageWebview.dispose();
            hiddenStorageWebview = undefined;
        }

        isExtensionRunning = false;
        isStorageReady = false;
        webviewClosed = false;
        pendingFiles = [];
        storedFiles = [];
        console.log('🛑 File change listener stopped');
    }

    // Create completely empty embedded webview
    async function createEmbeddedHiddenWebview() {
        if (webviewClosed) {
            console.log('⚠️ Webview was closed, not recreating');
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            console.log('🔧 Creating embedded hidden webview...');
            
            // Create webview with minimal visibility
            hiddenStorageWebview = vscode.window.createWebviewPanel(
                'embeddedStorage',
                '', // Empty title
                { 
                    viewColumn: vscode.ViewColumn.Beside, // Try to open in side panel
                    preserveFocus: true // Don't steal focus
                },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [],
                    // Minimal options for embedded feel
                    enableFindWidget: false,
                    enableCommandUris: false
                }
            );

            // Set completely empty HTML
            hiddenStorageWebview.webview.html = getMinimalEmbeddedHTML();

            // Immediately minimize/hide the webview
            setTimeout(() => {
                // Try multiple methods to hide the webview
                vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            }, 50);

            // Handle messages from webview
            hiddenStorageWebview.webview.onDidReceiveMessage(async (message) => {
                switch (message.type) {
                    case 'storageReady':
                        isStorageReady = true;
                        console.log('✅ Embedded localStorage ready');
                        
                        // Process pending files
                        if (pendingFiles.length > 0) {
                            console.log(`📦 Processing ${pendingFiles.length} pending files...`);
                            for (const file of pendingFiles) {
                                hiddenStorageWebview!.webview.postMessage({
                                    type: 'storeFile',
                                    data: file
                                });
                            }
                            pendingFiles = [];
                        }

                        vscode.window.showInformationMessage('✅ File storage active with localStorage!');
                        resolve();
                        break;

                    case 'fileStored':
                        // Silent logging only
                        console.log('💾 File stored:', message.data.fileName);
                        break;

                    case 'allFiles':
                        storedFiles = message.data;
                        displayRetrievedFiles(message.data);
                        break;

                    case 'storageInfo':
                        const info = message.data;
                        vscode.window.showInformationMessage(
                            `📊 localStorage: ${info.totalFiles} files, ${info.storageSize} KB`
                        );
                        break;

                    case 'dataExported':
                        vscode.window.showInformationMessage('📤 Data exported');
                        break;

                    case 'error':
                        console.error('❌ Storage error:', message.data);
                        vscode.window.showErrorMessage('Storage error: ' + message.data);
                        break;
                }
            });

            // Handle disposal - DON'T recreate
            hiddenStorageWebview.onDidDispose(() => {
                console.log('🗑️ Embedded webview disposed');
                hiddenStorageWebview = undefined;
                isStorageReady = false;
                webviewClosed = true;
                
                // Silent notification only
                console.log('ℹ️ localStorage closed, switching to memory cache');
            });

            // Timeout
            setTimeout(() => {
                if (!isStorageReady) {
                    reject(new Error('Embedded storage initialization timeout'));
                }
            }, 8000);
        });
    }

    // Handle file changes
    async function handleFileChange(uri: vscode.Uri, changeType: 'created' | 'modified' | 'deleted') {
        try {
            let content = '';
            if (changeType !== 'deleted') {
                const fileContent = await vscode.workspace.fs.readFile(uri);
                content = uint8ArrayToString(fileContent);
            }

            const record: FileChangeRecord = {
                filePath: uri.fsPath,
                content: content,
                timestamp: Date.now(),
                changeType: changeType
            };

            if (hiddenStorageWebview && isStorageReady && !webviewClosed) {
                // Store in localStorage
                hiddenStorageWebview.webview.postMessage({
                    type: 'storeFile',
                    data: record
                });
            } else {
                // Cache in memory
                storedFiles.push(record);
                
                if (storedFiles.length > 1000) {
                    storedFiles = storedFiles.slice(-1000);
                }
            }

        } catch (error) {
            console.error('Error handling file change:', error);
        }
    }

    // Export cached files
    function exportCachedFiles() {
        const exportData = {
            files: storedFiles,
            exportedAt: new Date().toISOString(),
            totalFiles: storedFiles.length,
            storageType: 'memory-cache'
        };
        
        const dataStr = JSON.stringify(exportData, null, 2);
        
        vscode.workspace.openTextDocument({
            content: dataStr,
            language: 'json'
        }).then(doc => {
            vscode.window.showTextDocument(doc).then(() => {
                vscode.window.showInformationMessage('📤 Cached files exported to document');
            });
        });
    }

    // Display retrieved files
    async function displayRetrievedFiles(files: FileChangeRecord[]) {
        const storageType = webviewClosed ? 'Memory Cache' : 'Browser localStorage';
        const totalSize = files.reduce((sum, file) => sum + file.content.length, 0);

        let report = `# File Storage Report\n\n`;
        report += `**Storage:** ${storageType}\n`;
        report += `**Files:** ${files.length}\n`;
        report += `**Size:** ${Math.round(totalSize / 1024)} KB\n\n`;
        
        report += `## Recent Files (Last 20)\n\n`;
        
        const recentFiles = files.slice(-20).reverse();
        recentFiles.forEach(file => {
            const fileName = file.filePath.split('/').pop();
            const time = new Date(file.timestamp).toLocaleString();
            report += `### ${fileName}\n`;
            report += `- **Path:** ${file.filePath}\n`;
            report += `- **Type:** ${file.changeType}\n`;
            report += `- **Time:** ${time}\n`;
            report += `- **Size:** ${file.content.length} chars\n\n`;
        });

        const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown'
        });
        
        await vscode.window.showTextDocument(doc);
    }

    // Register commands
    context.subscriptions.push(
        startExtensionCommand,
        stopExtensionCommand,
        getStoredFilesCommand,
        getStorageInfoCommand,
        exportDataCommand
    );
    
    console.log('🎉 File change listener ready with embedded storage');
}

// Completely minimal HTML - no visible content
function getMinimalEmbeddedHTML(): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title></title>
<style>
* { margin: 0; padding: 0; }
html, body { 
    height: 1px; 
    width: 1px; 
    overflow: hidden; 
    background: transparent;
    border: none;
    outline: none;
}
</style>
</head>
<body>
<script>
const vscode = acquireVsCodeApi();
const STORAGE_KEY = 'fileChangeData';
let allFiles = [];
let isReady = false;

function init() {
    try {
        localStorage.setItem('test', 'ok');
        localStorage.removeItem('test');
        
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            allFiles = JSON.parse(stored);
        }
        
        isReady = true;
        vscode.postMessage({ type: 'storageReady' });
    } catch (error) {
        vscode.postMessage({ type: 'error', data: error.message });
    }
}

window.addEventListener('message', event => {
    const message = event.data;
    
    switch (message.type) {
        case 'storeFile':
            if (!isReady) return;
            try {
                allFiles.push(message.data);
                if (allFiles.length > 5000) {
                    allFiles = allFiles.slice(-5000);
                }
                localStorage.setItem(STORAGE_KEY, JSON.stringify(allFiles));
                const fileName = message.data.filePath.split('/').pop();
                vscode.postMessage({
                    type: 'fileStored',
                    data: { fileName, total: allFiles.length }
                });
            } catch (error) {
                vscode.postMessage({ type: 'error', data: error.message });
            }
            break;
            
        case 'getAllFiles':
            vscode.postMessage({ type: 'allFiles', data: allFiles });
            break;
            
        case 'getStorageInfo':
            vscode.postMessage({
                type: 'storageInfo',
                data: {
                    totalFiles: allFiles.length,
                    storageSize: Math.round(JSON.stringify(allFiles).length / 1024),
                    lastActivity: allFiles.length > 0 ? 
                        new Date(Math.max(...allFiles.map(f => f.timestamp))).toLocaleString() : 'Never'
                }
            });
            break;
            
        case 'exportData':
            if (allFiles.length === 0) return;
            const exportData = {
                files: allFiles,
                exportedAt: new Date().toISOString(),
                totalFiles: allFiles.length,
                storageType: 'embedded-localStorage'
            };
            const dataStr = JSON.stringify(exportData, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = \`embedded-storage-\${new Date().toISOString().split('T')[0]}.json\`;
            a.click();
            URL.revokeObjectURL(url);
            vscode.postMessage({ type: 'dataExported' });
            break;
    }
});

document.addEventListener('DOMContentLoaded', init);
</script>
</body>
</html>`;
}

export function deactivate() {
    console.log('👋 File change listener deactivated');
}
