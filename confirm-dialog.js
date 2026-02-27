/**
 * Confirm Dialog - Module/wire deletion confirmation
 *
 * Modal dialog showing deletion impact (routes removed, orphaned modules).
 * Depends on: React
 */

function ConfirmDialog({ dialog, onConfirm, onCancel }) {
    // Build message based on dialog type
    let title, message;

    if (dialog.type === 'module') {
        title = `Delete ${dialog.name}?`;
        const lines = [];

        if (dialog.impact.routesRemoved.length > 0) {
            lines.push('This will remove:');
            dialog.impact.routesRemoved.forEach(r => {
                lines.push(`  - ${r.source} → ${r.param} (amount: ${r.amount})`);
            });
        }

        if (dialog.impact.orphanedModules.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push('This will also disconnect:');
            dialog.impact.orphanedModules.forEach(m => {
                lines.push(`  - ${m} (no remaining targets)`);
            });
        }

        if (lines.length === 0) {
            lines.push('This module has no active connections.');
        }

        message = lines.join('\n');
    } else if (dialog.type === 'wire') {
        title = 'Delete Connection?';
        message = `Remove ${dialog.source} → ${dialog.param}${dialog.amount !== undefined ? ` (amount: ${dialog.amount})` : ''}`;
    }

    return (
        <div className="ap-modal-overlay">
            <div className="ap-confirm-dialog">
                <div className="ap-confirm-header">{title}</div>
                <pre className="ap-confirm-body">{message}</pre>
                <div className="ap-confirm-actions">
                    <button className="ap-btn ap-btn-secondary" onClick={onCancel}>Cancel</button>
                    <button className="ap-btn ap-btn-danger" onClick={onConfirm}>Delete</button>
                </div>
            </div>
        </div>
    );
}
