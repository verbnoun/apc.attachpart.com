/**
 * Patches List - Sidebar patch browser
 *
 * Rendered into the patches WindowManager column.
 * Supports drag-to-reorder, rename, delete, create.
 * Depends on: React (useState)
 */

function PatchesList({ patches, currentIndex, onSelect, onCreate, onDelete, onRename, onMove, isConnected, isLoading, loadingIndex }) {
    const [dragIndex, setDragIndex] = React.useState(null);
    const [editingIndex, setEditingIndex] = React.useState(null);
    const [editingName, setEditingName] = React.useState('');

    // Determine which index to highlight (loading takes precedence for immediate feedback)
    const highlightIndex = loadingIndex !== null ? loadingIndex : currentIndex;

    const handleDragStart = (index) => {
        setDragIndex(index);
    };

    const handleDragOver = (index, e) => {
        e.preventDefault();
    };

    const handleDrop = (targetIndex) => {
        if (dragIndex !== null && dragIndex !== targetIndex && onMove) {
            onMove(dragIndex, targetIndex);
        }
        setDragIndex(null);
    };

    const handleRename = (index) => {
        setEditingIndex(index);
        // Find patch by index (patches may have non-sequential indices)
        const patch = patches?.find(p => (typeof p === 'object' ? p.index : patches.indexOf(p)) === index);
        const patchName = typeof patch === 'object' ? patch.name : (patch || '');
        setEditingName(patchName);
    };

    const handleRenameSubmit = () => {
        if (editingIndex !== null && onRename) {
            onRename(editingIndex, editingName);
        }
        setEditingIndex(null);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleRenameSubmit();
        } else if (e.key === 'Escape') {
            setEditingIndex(null);
        }
    };

    // Renders directly into patches WindowManager column (sticky header + items)
    return (
        <>
            <div className="ap-patches-header">
                <span>Patches</span>
                <button className="ap-btn ap-btn-primary ap-patches-new" onClick={onCreate}>+ NEW</button>
            </div>
            {!isConnected && (
                <div className="ap-patches-empty">
                    <p>Not connected</p>
                </div>
            )}
            {isConnected && (!patches || patches.length === 0) && (
                <div className="ap-patches-empty">
                    <p>Loading...</p>
                </div>
            )}
            {patches && patches.map((patch, idx) => {
                // Handle both object format { index, name } and string format
                const patchIndex = typeof patch === 'object' ? patch.index : idx;
                const patchName = typeof patch === 'object' ? patch.name : patch;

                const isHighlighted = patchIndex === highlightIndex;
                const isDragging = patchIndex === dragIndex;

                return (
                    <div
                        key={patchIndex}
                        className={`ap-patch-item ${isHighlighted ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isLoading ? 'loading-disabled' : ''}`}
                        draggable={!isLoading}
                        onDragStart={() => !isLoading && handleDragStart(patchIndex)}
                        onDragOver={(e) => !isLoading && handleDragOver(patchIndex, e)}
                        onDrop={() => !isLoading && handleDrop(patchIndex)}
                        onClick={() => !isLoading && onSelect && onSelect(patchIndex)}
                    >
                        {editingIndex === patchIndex ? (
                            <input
                                className="ap-input ap-patch-name-input"
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                onBlur={handleRenameSubmit}
                                onKeyDown={handleKeyDown}
                                autoFocus
                            />
                        ) : (
                            <>
                                <span className="ap-patch-name">{patchName}</span>
                                <div className="ap-patch-actions">
                                    <button
                                        className="ap-patch-action"
                                        onClick={(e) => { e.stopPropagation(); handleRename(patchIndex); }}
                                        title="Rename"
                                    >
                                        E
                                    </button>
                                    <button
                                        className="ap-patch-action ap-patch-delete"
                                        onClick={(e) => { e.stopPropagation(); onDelete && onDelete(patchIndex); }}
                                        title="Delete"
                                    >
                                        X
                                    </button>
                                </div>
                        </>
                    )}
                </div>
                );
            })}
        </>
    );
}
