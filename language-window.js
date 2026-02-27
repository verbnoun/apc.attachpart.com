/**
 * Language Window - Device language selection UI
 *
 * Standalone tool window for changing device display language.
 * Depends on: React (useState, useEffect)
 */

const AVAILABLE_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'jp', name: '日本語' }
];

function LanguageWindow({ device, api, deviceInfo, onClose, addLog }) {
    const [selectedLang, setSelectedLang] = React.useState('en');
    const [applying, setApplying] = React.useState(false);

    const currentLang = deviceInfo?.language || 'en';

    React.useEffect(() => {
        setSelectedLang(currentLang);
    }, [currentLang]);

    const handleApply = async () => {
        if (!api || selectedLang === currentLang) return;

        setApplying(true);
        addLog(`Setting language to ${selectedLang}...`, 'info');

        try {
            addLog('Language API not yet implemented', 'warning');
            setTimeout(() => {
                setApplying(false);
                onClose();
            }, 1000);
        } catch (err) {
            addLog(`Language change failed: ${err.message}`, 'error');
            setApplying(false);
        }
    };

    const deviceName = deviceInfo?.name || device;

    return (
        <div className="ap-language-window">
            <div className="ap-language-device">
                <span className="ap-language-device-name">{deviceName.toUpperCase()}</span>
            </div>

            <div className="ap-language-list">
                {AVAILABLE_LANGUAGES.map(lang => (
                    <label
                        key={lang.code}
                        className={`ap-language-option ${selectedLang === lang.code ? 'selected' : ''}`}
                    >
                        <input
                            type="radio"
                            name="language"
                            value={lang.code}
                            checked={selectedLang === lang.code}
                            onChange={(e) => setSelectedLang(e.target.value)}
                            disabled={applying}
                        />
                        <span className="ap-language-name">{lang.name}</span>
                        {lang.code === currentLang && (
                            <span className="ap-language-current">(current)</span>
                        )}
                    </label>
                ))}
            </div>

            <p className="ap-text-muted ap-language-note">
                Device will restart after language change.
            </p>

            <div className="ap-language-actions">
                <button
                    className="ap-btn ap-btn-primary"
                    onClick={handleApply}
                    disabled={applying || selectedLang === currentLang}
                >
                    {applying ? 'APPLYING...' : 'APPLY'}
                </button>
                <button className="ap-btn" onClick={onClose} disabled={applying}>
                    CANCEL
                </button>
            </div>
        </div>
    );
}
