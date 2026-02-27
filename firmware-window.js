/**
 * Firmware Window - Device firmware upload UI
 *
 * Standalone tool window for uploading .bin firmware files to connected devices.
 * Depends on: React (useState, useRef)
 */

const { useState: fwUseState, useRef: fwUseRef } = React;

function FirmwareWindow({ device, deviceInfo, api, onClose, addLog }) {
    const [step, setStep] = fwUseState('select');
    const [progress, setProgress] = fwUseState({ phase: '', percent: 0 });
    const [selectedFile, setSelectedFile] = fwUseState(null);
    const [error, setError] = fwUseState(null);
    const fileInputRef = fwUseRef(null);

    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (file) {
            setSelectedFile(file);
            setError(null);
        }
    };

    const handleUpload = async () => {
        if (!selectedFile || !api) return;

        setStep('uploading');
        setProgress({ phase: 'reading', percent: 0 });
        setError(null);

        try {
            const arrayBuffer = await selectedFile.arrayBuffer();
            const firmwareBin = new Uint8Array(arrayBuffer);

            addLog(`Starting firmware upload: ${firmwareBin.length} bytes`, 'info');

            await api.uploadFirmware(firmwareBin, (prog) => {
                setProgress(prog);
                addLog(`Firmware: ${prog.phase} ${prog.percent}%`, 'info');
            });

            setStep('complete');
            addLog('Firmware upload complete', 'success');
        } catch (err) {
            setStep('error');
            setError(err.message);
            addLog(`Firmware upload failed: ${err.message}`, 'error');
        }
    };

    const handleRestart = async () => {
        if (!api) return;

        try {
            addLog('Restarting device...', 'info');
            await api.restartDevice();
            onClose();
        } catch (err) {
            addLog(`Restart failed: ${err.message}`, 'error');
        }
    };

    const getProgressText = () => {
        switch (progress.phase) {
            case 'reading': return 'Reading file...';
            case 'erasing': return `Erasing flash... ${progress.percent}%`;
            case 'transferring': return `Transferring... ${progress.percent}%`;
            case 'flashing': return `Flashing... ${progress.percent}%`;
            case 'validated': return 'Firmware validated!';
            case 'complete': return 'Upload complete!';
            default: return 'Preparing...';
        }
    };

    const deviceName = deviceInfo?.name || device;

    return (
        <div className="ap-firmware-window">
            <div className="ap-firmware-device">
                <span className="ap-firmware-device-name">{deviceName.toUpperCase()}</span>
                {deviceInfo && (
                    <span className="ap-firmware-version">v{deviceInfo.version}</span>
                )}
            </div>

            {step === 'select' && (
                <div className="ap-firmware-select">
                    <input
                        type="file"
                        ref={fileInputRef}
                        accept=".bin"
                        onChange={handleFileSelect}
                        style={{ display: 'none' }}
                    />
                    <button
                        className="ap-btn"
                        onClick={() => fileInputRef.current?.click()}
                    >
                        SELECT .BIN FILE
                    </button>

                    {selectedFile && (
                        <div className="ap-firmware-file-info">
                            <span className="ap-firmware-filename">{selectedFile.name}</span>
                            <span className="ap-firmware-filesize">
                                {(selectedFile.size / 1024).toFixed(1)} KB
                            </span>
                        </div>
                    )}

                    {error && (
                        <p className="ap-text-danger ap-mt-sm">{error}</p>
                    )}

                    <div className="ap-firmware-actions">
                        <button
                            className="ap-btn ap-btn-primary"
                            onClick={handleUpload}
                            disabled={!selectedFile || !api}
                        >
                            START UPDATE
                        </button>
                        <button className="ap-btn" onClick={onClose}>
                            CANCEL
                        </button>
                    </div>
                </div>
            )}

            {step === 'uploading' && (
                <div className="ap-firmware-progress">
                    <p className="ap-firmware-status">{getProgressText()}</p>
                    <div className="ap-progress-bar">
                        <div
                            className="ap-progress-fill"
                            style={{ width: `${progress.percent}%` }}
                        />
                    </div>
                    <p className="ap-text-muted ap-mt-sm">
                        Do not disconnect the device!
                    </p>
                </div>
            )}

            {step === 'complete' && (
                <div className="ap-firmware-complete">
                    <p className="ap-text-success">Firmware upload complete!</p>
                    <p className="ap-text-muted ap-mt-sm">
                        Restart the device to apply the update.
                    </p>
                    <div className="ap-firmware-actions">
                        <button
                            className="ap-btn ap-btn-success"
                            onClick={handleRestart}
                        >
                            RESTART DEVICE
                        </button>
                        <button className="ap-btn" onClick={onClose}>
                            CLOSE
                        </button>
                    </div>
                </div>
            )}

            {step === 'error' && (
                <div className="ap-firmware-error">
                    <p className="ap-text-danger">Update Failed</p>
                    <p className="ap-text-muted ap-mt-sm">{error}</p>
                    <div className="ap-firmware-actions">
                        <button
                            className="ap-btn"
                            onClick={() => {
                                setStep('select');
                                setError(null);
                            }}
                        >
                            TRY AGAIN
                        </button>
                        <button className="ap-btn" onClick={onClose}>
                            CLOSE
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
