/**
 * Slider Curves Configuration
 *
 * ============================================================================
 * TEMPORARY FIX - BREAKS THIN CLIENT PRINCIPLE
 * ============================================================================
 *
 * WHY THIS EXISTS:
 * - Web editor is a thin client (no curve info in JSON from device)
 * - Firmware uses LOG curves for frequency parameters
 * - Without this, slider position doesn't match audio output
 *
 * TO REMOVE THIS MODULE:
 * 1. Delete this file (slider-config.js)
 * 2. Remove <script src="slider-config.js"> from index.html
 * 3. In app.js ValueSlider: remove paramName prop and SliderConfig usage
 *    (the fallback LINEAR math will work automatically)
 *
 * @file slider-config.js
 * @date 2025-12-18
 */

(function(global) {
    'use strict';

    //==========================================================================
    // CURVE DEFINITIONS
    //==========================================================================

    const CURVES = {
        LINEAR: {
            valueToPercent: (value, min, max) => {
                if (max === min) return 0.5;
                return (value - min) / (max - min);
            },
            percentToValue: (percent, min, max) => {
                return min + percent * (max - min);
            }
        },

        LOG: {
            // percent = log(value/min) / log(max/min)
            valueToPercent: (value, min, max) => {
                if (max === min || min <= 0 || value <= 0) return 0.5;
                return Math.log(value / min) / Math.log(max / min);
            },
            // value = min * (max/min)^percent
            percentToValue: (percent, min, max) => {
                if (max === min || min <= 0) return min;
                return min * Math.pow(max / min, percent);
            }
        }
    };

    //==========================================================================
    // PARAMETER MAPPINGS - ADD/REMOVE CURVES HERE
    //==========================================================================

    const PARAM_CURVES = {
        'VLFO_FREQUENCY': CURVES.LOG,
        'GLFO_FREQUENCY': CURVES.LOG,
        'FILTER_FREQUENCY': CURVES.LOG,
    };

    //==========================================================================
    // PUBLIC API
    //==========================================================================

    global.SliderConfig = {
        getCurve: (paramName) => PARAM_CURVES[paramName] || CURVES.LINEAR
    };

})(window);
