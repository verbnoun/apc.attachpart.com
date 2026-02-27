/**
 * Log Window - Console log and topology viewer
 *
 * Displays application logs or device topology JSON.
 * View is controlled by parent via activeView prop.
 */

function LogWindow({ logs, topology, activeView }) {
    const logText = logs.map(log => {
        const typeTag = log.type === 'info' ? '' : `[${log.type.toUpperCase()}] `;
        return `[${log.timestamp}] ${typeTag}${log.message}`;
    }).join('\n');

    const topoText = topology
        ? JSON.stringify(topology, null, 2)
        : 'No topology loaded (connect a synth device)';

    return (
        <pre className="ap-log-text">
            {activeView === 'log'
                ? (logs.length === 0 ? 'No log entries' : logText)
                : topoText}
        </pre>
    );
}
