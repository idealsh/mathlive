/**
 * 
 * See {@linkcode MathField}
 * @module editor/mathfield
 * @private
 */
import Definitions from '../core/definitions.js';
import MathAtom from '../core/mathAtom.js';
import Lexer from '../core/lexer.js';
import ParserModule from '../core/parser.js';
import Span from '../core/span.js';
import EditableMathlist from './editor-editableMathlist.js';
import MathPath from './editor-mathpath.js';
import Keyboard from './editor-keyboard.js';
import Undo from './editor-undo.js';
import Shortcuts from './editor-shortcuts.js';
import Popover from './editor-popover.js';
import VirtualKeyboard from './editor-virtualKeyboard.js';
import GraphemeSplitter from '../core/grapheme-splitter.js';
import { toASCIIMath } from './outputASCIIMath.js';
import { l10n } from './l10n.js';
import OutputLatex from '../addons/outputLatex.js'; // eslint-disable-line no-unused-vars
import OutputMathML from '../addons/outputMathML.js'; // eslint-disable-line no-unused-vars
import MASTON from '../addons/maston.js'; // eslint-disable-line no-unused-vars
import OutputSpokenText from '../addons/outputSpokenText.js'; // eslint-disable-line no-unused-vars

/*
    Note:
    The OutputLatex, OutputMathML, MASTON and OutputSpokenText  modules are required,
    even though they are not referenced directly.

    They modify the MathAtom class, adding toLatex(), toMathML() and
    toSpeakableText() respectively.
*/


const HAPTIC_FEEDBACK_DURATION = 3; // in ms
const AUDIO_FEEDBACK_VOLUME = 0.5; // from 0.0 to 1.0

function on(el, selectors, listener, options) {
    selectors = selectors.split(' ');
    for (const sel of selectors) {
        const m = sel.match(/(.*):(.*)/);
        if (m) {
            const options2 = options || {};
            if (m[2] === 'active') {
                options2.passive = false;
            } else {
                options2[m[2]] = true;
            }
            el.addEventListener(m[1], listener, options2);
        } else {
            el.addEventListener(sel, listener, options);
        }
    }
}

function off(el, selectors, listener, options) {
    selectors = selectors.split(' ');
    for (const sel of selectors) {
        const m = sel.match(/(.*):(.*)/);
        if (m) {
            const options2 = options || {};
            if (m[2] === 'active') {
                options2.passive = false;
            } else {
                options2[m[2]] = true;
            }
            el.removeEventListener(m[1], listener, options2);
        } else {
            el.removeEventListener(sel, listener, options);
        }
    }
}

function getSharedElement(id, cls) {
    let result = document.getElementById(id);
    if (result) {
        result.setAttribute('data-refcount', 
            parseInt(result.getAttribute('data-refcount')) + 1);
    } else {
        result = document.createElement('div');
        result.setAttribute('aria-hidden', 'true');
        result.setAttribute('data-refcount', '1');
        result.className = cls;
        result.id = id;
        document.body.appendChild(result);
    }
    return result;
}

function releaseSharedElement(el) {
    if (!el) return null;
    const refcount = parseInt(el.getAttribute('data-refcount'));
    if (!refcount || refcount === 1) {
        el.remove();
    } else {
        el.setAttribute('data-refcount', refcount - 1);
    }
    return el;
}


/**
 * To create a mathfield, you would typically use {@linkcode module:MathLive#makeMathField MathLive.makeMathField()}
 * instead of invoking directly this constructor.
 * 
 * **Note**
 * - Method names that begin with `$` are public.
 * - Method names that _begin with_ an underbar `_` are private and meant
 * to be used only by the implementation of the class.
 * - Method names that _end with_ an underbar `_` are selectors. They can
 * be invoked by calling [`MathField.$perform()`]{@link MathField#$perform}. Note
 * that the selector name does not include the underbar.
 *
 * For example:
 * ```
 *    mf.$perform('selectAll');
 * ```
 * 
 * @param {Element} element - The DOM element that this mathfield is attached to.
 * Note that `element.mathfield` is this object.
 * @param {object} config - See {@tutorial CONFIG} for details
 * @property {Element} element - The DOM element this mathfield is attached to.
 * @property {Object.<string, any>} config - A set of key/value pairs that can
 * be used to customize the behavior of the mathfield
 * @property {string} id - A unique ID identifying this mathfield
 * @property {boolean} keystrokeCaptionVisible - True if the keystroke caption
 * panel is visible
 * @property {boolean} virtualKeyboardVisible - True if the virtual keyboard is 
 * visible
 * @property {string} keystrokeBuffer The last few keystrokes, to look out
 * for inline shortcuts
 * @property {object[]} keystrokeBufferStates The saved state for each of the 
 * past keystrokes
 * @class
 * @global
 */
function MathField(element, config) {
    // Setup default config options
    this.$setConfig(config || {});

    this.element = element;
    element.mathfield = this;

    // Save existing content
    this.originalContent = element.innerHTML;
    let elementText = this.element.textContent;
    if (elementText) elementText = elementText.trim();

    // Additional elements used for UI.
    // They are retrieved in order a bit later, so they need to be kept in sync
    // 1.0/ The field, where the math equation will be displayed
    // 1.1/ The widget to activate the command bar
    // 2/ The popover panel which displays info in command mode
    // 3/ The keystroke caption panel (option+shift+K)
    // 4/ The virtual keyboard
    // 5.0/ The area to stick MathML for screen reading larger exprs (not used right now)
    //      The for the area is that focus would bounce their and then back triggering the
    //         screen reader to read it
    // 5.1/ The aria-live region for announcements
    let markup = ''
    if (!this.config.substituteTextArea) {
        if (/android|ipad|ipod|iphone/i.test(navigator.userAgent)) {
            // On Android or iOS, don't use a textarea, which has the side effect of
            // bringing up the OS virtual keyboard
            markup += `<span class='ML__textarea'>
                <span class='ML__textarea__textarea'
                    tabindex="0" role="textbox"
                    style='display:inline-block;height:1px;width:1px' >
                </span>
            </span>`;
        } else {
            markup += '<span class="ML__textarea">' +
                '<textarea class="ML__textarea__textarea" autocapitalize="off" autocomplete="off" ' +
                'autocorrect="off" spellcheck="false" aria-hidden="true" tabindex="-1">' +
                '</textarea>' +
            '</span>';
        }

    } else {
        if (typeof this.config.substituteTextArea === 'string') {
            markup += this.config.substituteTextArea;
        } else {
            // We don't really need this one, but we keep it here so that the
            // indexes below remain the same whether a substituteTextArea is
            // provided or not.
            markup += '<span></span>';
        }
    }
    markup += '<span class="ML__fieldcontainer">' +
            '<span class="ML__fieldcontainer__field"></span>';

    // If no value is specified for the virtualKeyboardMode, use 
    // `onfocus` on touch-capable devices and `off` otherwise.
    if (!this.config.virtualKeyboardMode) {
        this.config.virtualKeyboardMode = 
            (window.matchMedia && window.matchMedia("(any-pointer: coarse)").matches
) ? 'onfocus' : 'off';
    }

    // Only display the virtual keyboard toggle if the virtual keyboard mode is
    // 'manual'
    if (this.config.virtualKeyboardMode === 'manual') {
        markup += `<button class="ML__virtual-keyboard-toggle" data-tooltip="${l10n('tooltip.toggle virtual keyboard')}">`;
                    // data-tooltip='Toggle Virtual Keyboard'
        if (this.config.virtualKeyboardToggleGlyph) {
            markup += this.config.virtualKeyboardToggleGlyph;
        } else {
            markup += `<span style="width: 21px; margin-top: 4px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path d="M528 64H48C21.49 64 0 85.49 0 112v288c0 26.51 21.49 48 48 48h480c26.51 0 48-21.49 48-48V112c0-26.51-21.49-48-48-48zm16 336c0 8.823-7.177 16-16 16H48c-8.823 0-16-7.177-16-16V112c0-8.823 7.177-16 16-16h480c8.823 0 16 7.177 16 16v288zM168 268v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm96 0v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm96 0v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm96 0v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm-336 80v-24c0-6.627-5.373-12-12-12H84c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm384 0v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zM120 188v-24c0-6.627-5.373-12-12-12H84c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm96 0v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm96 0v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm96 0v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm96 0v-24c0-6.627-5.373-12-12-12h-24c-6.627 0-12 5.373-12 12v24c0 6.627 5.373 12 12 12h24c6.627 0 12-5.373 12-12zm-96 152v-8c0-6.627-5.373-12-12-12H180c-6.627 0-12 5.373-12 12v8c0 6.627 5.373 12 12 12h216c6.627 0 12-5.373 12-12z"/></svg></span>`;
        }
        markup += '</button>';
    } else {
        markup += '<span ></span>';
    }
    markup += '</span>';

    markup += `
        <div class="sr-only">
            <span aria-live="assertive" aria-atomic="true"></span>
            <span></span>
        </div>
    `;

    this.element.innerHTML = markup;

    let iChild = 0;       // index of child -- used to make changes below easier
    if (typeof this.config.substituteTextArea === 'function') {
        this.textarea =  this.config.substituteTextArea();
    } else {
        this.textarea = this.element.children[iChild++].firstElementChild;
    }
    this.field = this.element.children[iChild].children[0];
    this.virtualKeyboardToggleDOMNode = this.element.children[iChild++].children[1];
    this._attachButtonHandlers(this.virtualKeyboardToggleDOMNode,
        {
            default: 'toggleVirtualKeyboard',
            alt: 'toggleVirtualKeyboardAlt',
            shift: 'toggleVirtualKeyboardShift'
        }
    );
    this.ariaLiveText = this.element.children[iChild].children[0];
    this.accessibleNode = this.element.children[iChild++].children[1];

    // Some panels are shared amongst instances of mathfield
    // (there's a single instance in the document)
    this.popover = getSharedElement('mathlive-popover-panel', 'ML__popover');
    this.keystrokeCaption = getSharedElement('mathlive-keystroke-caption-panel', 'ML__keystroke-caption');

    // The keystroke caption panel and the command bar are
    // initially hidden
    this.keystrokeCaptionVisible = false;
    this.virtualKeyboardVisible = false;

    this.keystrokeBuffer = '';
    this.keystrokeBufferStates = [];
    this.keystrokeBufferResetTimer = null;

    // This index indicates which of the suggestions available to
    // display in the popover panel
    this.suggestionIndex = 0;

    // The input mode (text, math, command)
    // While mathlist.anchorMode() represent the mode of the current selection,
    // this.mode is the mode chosen by the user. It indicates the mode the 
    // next character typed will be interpreted in. 
    // It is often identical to mathlist.anchorMode() since changing the selection
    // changes the mode, but sometimes it is not, for example when a user 
    // enters a mode changing command.
    this.mode = config.defaultMode || 'math';
    this.smartModeSuppressed = false;

    // Focus/blur state
    this.blurred = true;
    on(window, 'focus', this);
    on(window, 'blur', this);
    on(this.element, 'focus', this);
    on(this.element, 'blur', this);

    // Capture clipboard events
    on(this.textarea, 'cut', this);
    on(this.textarea, 'copy', this);
    on(this.textarea, 'paste', this);

    // Delegate keyboard events
    Keyboard.delegateKeyboardEvents(this.textarea, {
        container:      this.element,
        allowDeadKey:   () => this.mode === 'text',
        typedText:      this._onTypedText.bind(this),
        paste:          this._onPaste.bind(this),
        keystroke:      this._onKeystroke.bind(this),
        // focus:          this._onFocus.bind(this),
        // blur:           this._onBlur.bind(this),
    })



    // Delegate mouse and touch events
    on(this.element, 'touchstart:active mousedown', this);

    // Request notification for when the window is resized (
    // or the device switched from portrait to landscape) to adjust
    // the UI (popover, etc...)
    on(window, 'resize', this);


    // Override some handlers in the config
    const localConfig = {...config};
    localConfig.onSelectionDidChange =
        MathField.prototype._onSelectionDidChange.bind(this);
    localConfig.onContentDidChange =
        MathField.prototype._onContentDidChange.bind(this);
    localConfig.onAnnounce = this.config.onAnnounce;
    localConfig.smartFence = this.config.smartFence;
    localConfig.macros = this.config.macros;
    localConfig.removeExtraneousParentheses = this.config.removeExtraneousParentheses;

    this.mathlist = new EditableMathlist.EditableMathlist(localConfig, this);

    // Prepare to manage undo/redo
    this.undoManager = new Undo.UndoManager(this.mathlist);

    // If there was some content in the element, use it for the initial
    // value of the mathfield
    if (elementText.length > 0) {
        this.$latex(elementText);
    }

    // Now start recording potentially undoable actions
    this.undoManager.startRecording();
    this.undoManager.snapshot(this.config);
}

/**
 * handleEvent is a function invoked when an event registered with an
 * object instead of a function is emitted. 
 * The name is defined by addEventListener() and cannot be changed.
 * This pattern is used to be able to release bound event handlers, 
 * (event handlers that need access to `this`) as the bind() function
 * would create a new function that would have to be kept track off
 * to be able to properly remove the event handler later.
 */
MathField.prototype.handleEvent = function(evt) {
    switch(evt.type) {
        case 'focus': this._onFocus(evt); break;
        case 'blur': this._onBlur(evt); break;
        case 'touchstart': this._onPointerDown(evt); break;
        case 'mousedown': this._onPointerDown(evt); break;
        case 'resize': {
            if (this._resizeTimer) window.cancelAnimationFrame(this._resizeTimer);
            this._resizeTimer = window.requestAnimationFrame( () => this._onResize());
            break;
        }
        case 'cut': this._onCut(evt); break;
        case 'copy': this._onCopy(evt); break;
        case 'paste': this._onPaste(evt); break;
        default: console.warn('Unexpected event type', evt.type);
    }
}


/**
 * Revert this math field to its original content. After this method has been
 * called, no other methods can be called on the MathField object. To turn the
 * element back into a MathField, call `MathLive.makeMathField()` on the
 * element again to get a new math field object.
 *
 * @method MathField#$revertToOriginalContent
 */
MathField.prototype.revertToOriginalContent = 
MathField.prototype.$revertToOriginalContent = function() {
    this.element.innerHTML = this.originalContent;
    this.element.mathfield = null;
    delete this.accessibleNode;
    delete this.ariaLiveText;
    delete this.field;
    off(this.textarea, 'cut', this);
    off(this.textarea, 'copy', this);
    off(this.textarea, 'paste', this);
    this.textarea.remove();
    delete this.textarea;
    this.virtualKeyboardToggleDOMNode.remove()
    delete this.virtualKeyboardToggleDOMNode;
    delete releaseSharedElement(this.popover);
    delete releaseSharedElement(this.keystrokeCaption);
    delete releaseSharedElement(this.virtualKeyboard);
    delete releaseSharedElement(document.getElementById('mathlive-alternate-keys-panel'));
    
    off(this.element, 'touchstart:active mousedown', this);
    off(this.element, 'focus', this);
    off(this.element, 'blur', this);
    off(window, 'resize', this);
    off(window, 'focus', this);
    off(window, 'blur', this);
}

MathField.prototype._resetKeystrokeBuffer = function() {
    this.keystrokeBuffer = '';
    this.keystrokeBufferStates = [];
    clearTimeout(this.keystrokeBufferResetTimer);
}

/**
 * Utility function that returns the element which has the caret
 *
 * @param {DomElement} el
 * @private
 */
function _findElementWithCaret(el) {
    if (el.classList.contains('ML__caret') || 
        el.classList.contains('ML__text-caret') ||
        el.classList.contains('ML__command-caret')) {
        return el;
    }
    let result;
    Array.from(el.children).forEach(function(child) {
        result = result || _findElementWithCaret(child);
    });
    return result;
}



/**
 * Return the (x,y) client coordinates of the caret
 *
 * @method MathField#_getCaretPosition
 * @private
 */
MathField.prototype._getCaretPosition = function() {
    const caret = _findElementWithCaret(this.field);
    if (caret) {
        const bounds = caret.getBoundingClientRect();
        return {
            x: bounds.right + window.scrollX,
            y: bounds.bottom + window.scrollY };
    }
    return null;
}


/**
 * Return a tuple of an element and a distance from point (x, y)
 * @param {Element} el
 * @param {number} x
 * @param {number} y
 * @function module:editor/mathfield#nearestElementFromPoint
 * @private
 */
function nearestElementFromPoint(el, x, y) {
    let result = { element: null };
    let considerChildren = true;
    if (!el.getAttribute('data-atom-id')) {
        // This element may not have a matching atom, but its children might
        result.distance = Number.POSITIVE_INFINITY;
    } else {
        result.element = el;

        // Calculate the (square of the) distance to the rectangle
        const r = el.getBoundingClientRect();
        const dx = Math.max(r.left - x, x - r.right);
        const dy = Math.max(r.top - y, y - r.bottom);
        result.distance = dx * dx + dy * dy;

        // Only consider children if the target is inside the (horizontal) 
        // bounds of the element.
        // This avoid searching the numerator/denominator when a fraction
        // is the last element in the formula.
        considerChildren = x >= r.left && x <= r.right;
    }

    if (considerChildren && el.children) {
        Array.from(el.children).forEach(function(child) {
            const nearest = nearestElementFromPoint(child, x, y);
            if (nearest.element && nearest.distance <= result.distance) {
                result = nearest;
            }
        });
    }

    return result;
}

/**
 * @param {number} x 
 * @param {number} y 
 * @param {object} options
 * @param {boolean} options.bias  if 0, the midpoint of the bounding box
 * is considered to return the sibling. If <0, the left sibling is 
 * favored, if >0, the right sibling
 */
MathField.prototype._pathFromPoint = function(x, y, options) {
    options = options || {};
    options.bias = options.bias || 0; 
    let result;
    // Try to find the deepest element that is near the point that was
    // clicked on (the point could be outside of the element)
    const nearest = nearestElementFromPoint(this.field, x, y);
    const el = nearest.element;
    const id = el ? el.getAttribute('data-atom-id') : null;

    if (id) {
        // Let's find the atom that has a matching ID with the element that
        // was clicked on (or near)
        const paths = this.mathlist.filter(function(_path, atom) {
            // If the atom allows children to be selected, match only if
            // the ID of  the atom matches the one we're looking for.
            if (!atom.captureSelection) {
                return atom.id === id;
            }
            // If the atom does not allow children to be selected
            // (captureSelection === true), the element matches if any of
            // its children has an ID that matches.
            return atom.filter(childAtom => childAtom.id === id).length > 0;
        });

        if (paths && paths.length > 0) {
            // (There should be exactly one atom that matches this ID...)
            // Set the result to the path to this atom

            result = MathPath.pathFromString(paths[0]).path;

            if (options.bias === 0) {
                // If the point clicked is to the left of the vertical midline,
                // adjust the path to *before* the atom (i.e. after the
                // preceding atom)
                const bounds = el.getBoundingClientRect();
                if (x < bounds.left + bounds.width / 2 && !el.classList.contains('ML__placeholder')) {
                    result[result.length - 1].offset =
                        Math.max(0, result[result.length - 1].offset - 1);
                }
            } else if (options.bias < 0) {
                result[result.length - 1].offset =
                    Math.min(this.mathlist.siblings().length - 1, Math.max(0, 
                        result[result.length - 1].offset + options.bias));
            }
        }
    }
    return result;
}

let lastTouchEndTouch;
let lastTouchEndTimestamp;
let tapCount = 0;

MathField.prototype._onPointerDown = function(evt) {
    let anchor;
    const that = this;
    let trackingPointer = false;
    let trackingWords = false;
    let dirty = false;

    function endPointerTracking(evt) {
        off(that.field, 'touchmove', onPointerMove);
        off(that.field, 'touchend touchleave', endPointerTracking);
        off(window, 'mousemove', onPointerMove);
        off(window, 'mouseup blur', endPointerTracking);

        trackingPointer = false;
        evt.preventDefault();
        evt.stopPropagation();
    }

    function onPointerMove(evt) {
        const x = evt.touches ? evt.touches[0].clientX : evt.clientX;
        const y = evt.touches ? evt.touches[0].clientY : evt.clientY;
        let actualAnchor = anchor;

        if (evt.touches && evt.touches.length === 2) {
            actualAnchor = that._pathFromPoint(
                evt.touches[1].clientX, evt.touches[1].clientY, {bias: 0});
        }

        const focus = that._pathFromPoint(x, y, 
            {bias: x <= anchorX ? (x === anchorX ? 0 : -1) : +1});

        if (focus && that.mathlist.setRange(actualAnchor, focus, 
            {extendToWordBoundary: trackingWords})) {
            // Re-render if the range has actually changed
            requestAnimationFrame(that._render.bind(that));
        }
        // Prevent synthetic mouseMove event when this is a touch event
        evt.preventDefault();
        evt.stopPropagation();
    }

    // Calculate the tap count (if this is a touch event)
    if (evt.touches && evt.touches.length === 1) {
        if (lastTouchEndTouch && Math.abs(lastTouchEndTouch.pageX - evt.touches[0].pageX) < 5 &&
            Math.abs(lastTouchEndTouch.pageY - evt.touches[0].pageY) < 5 &&
            Date.now() < lastTouchEndTimestamp + 500) {
            tapCount += 1;
        } else {
            lastTouchEndTouch = evt.touches[0];
            tapCount = 1;
        }
        lastTouchEndTimestamp = Date.now();
    }

    // This should not be necessary, but just in case we got in a weird state...
    off(this.field, 'touchmove', onPointerMove);
    off(this.field, 'touchend touchleave', endPointerTracking);
    off(window, 'mousemove', onPointerMove);
    off(window, 'mouseup blur', endPointerTracking);

    const anchorX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const anchorY = evt.touches ? evt.touches[0].clientY : evt.clientY;
    const bounds = this.element.getBoundingClientRect();
    if (anchorX >= bounds.left && anchorX <= bounds.right &&
        anchorY >= bounds.top && anchorY <= bounds.bottom) {

        // Focus the math field
        if (!this.hasFocus()) {
            dirty = true;
            if (this.textarea.focus) this.textarea.focus();
        }

        // Clicking or tapping the field resets the keystroke buffer and 
        // smart mode
        this._resetKeystrokeBuffer();
        this.smartModeSuppressed = false;

        // If a mouse button other than the main one was pressed, return
        if (evt.buttons && evt.buttons !== 1) return;

        anchor = this._pathFromPoint(anchorX, anchorY, {bias: 0});
        if (anchor) {

            if (evt.shiftKey) {
                // Extend the selection if the shift-key is down
                this.mathlist.setRange(this.mathlist.path, anchor);
                anchor = MathPath.clone(this.mathlist.path);
                anchor[anchor.length - 1].offset -= 1;
            } else {
                this.mathlist.setPath(anchor, 0);
            }
            // The selection has changed, so we'll need to re-render
            dirty = true;

            // evt.details contains the number of consecutive clicks
            // for double-click, triple-click, etc...
            if (evt.detail === 3 || tapCount > 2) {
                off(this.field, 'touchmove', onPointerMove);
                off(this.field, 'touchend', endPointerTracking);
                off(window, 'mousemove', onPointerMove);
                off(window, 'mouseup blur', endPointerTracking);
                trackingPointer = false;
                if (evt.detail === 3 || tapCount === 3) {
                    // This is a triple-click
                    this.mathlist.selectAll_();
                }
            } else {
                if (!trackingPointer) {
                    trackingPointer = true;
                    on(window, 'blur', endPointerTracking);
                    if (evt.touches) {
                        // To receive the subsequent touchmove/touch, need to
                        // listen to this evt.target.
                        // This was a touch event
                        on(evt.target, 'touchmove', onPointerMove);
                        on(evt.target, 'touchend', endPointerTracking);
                    } else {
                        on(window, 'mousemove', onPointerMove);
                        on(window, 'mouseup', endPointerTracking);
                    }
                    if (evt.detail === 2 || tapCount === 2) {
                        // This is a double-click
                        trackingWords = true;
                        this.mathlist.selectGroup_();
                    }
                }
            }
        }
    } else {
        lastTouchEndTouch = null;
    }


    if (dirty) this._render();

    // Prevent the browser from handling, in particular when this is a
    // touch event prevent the synthetic mouseDown event from being generated
    evt.preventDefault();
}

MathField.prototype._onSelectionDidChange = function() {
    // Every atom before the new caret position is now committed
    this.mathlist.commitCommandStringBeforeInsertionPoint();

    // If the selection is not collapsed, put it in the textarea
    // This will allow cut/copy to work.
    let result = '';
    this.mathlist.forEachSelected(atom => { result += atom.toLatex() });
    if (result) {
        this.textarea.value = result;
        // The textarea may be a span (on mobile, for example), so check that
        // it has a select() before calling it.
        if (this.hasFocus() && this.textarea.select) {
            this.textarea.select();
        }
    } else {
        this.textarea.value = '';
        this.textarea.setAttribute('aria-label', '');
    }

    // Update the mode
    {
        const previousMode = this.mode;
        this.mode = this.mathlist.anchorMode() || this.config.defaultMode;
        if (this.mode !== previousMode && typeof this.config.onModeChange === 'function') {
            this.config.onModeChange(this, this.mode)
        }
    }

    // Defer the updating of the popover position: we'll need the tree to be
    // re-rendered first to get an updated caret position
    Popover.updatePopoverPosition(this, {deferred: true});

    // Invoke client handlers, if provided.
    if (typeof this.config.onSelectionDidChange === 'function') {
        this.config.onSelectionDidChange(this);
    }
}



MathField.prototype._onContentDidChange = function() {
    if (this.undoManager.canRedo()) {
        this.element.classList.add('can-redo');
    } else {
        this.element.classList.remove('can-redo');
    }
    if (this.undoManager.canUndo()) {
        this.element.classList.add('can-undo');
    } else {
        this.element.classList.remove('can-undo');
    }
    if (typeof this.config.onContentDidChange === 'function') {
        this.config.onContentDidChange(this);
    }
}

/* Returns the speech text of the next atom after the selection or
 *   an 'end of' phrasing based on what structure we are at the end of
 */
MathField.prototype._nextAtomSpeechText = function(oldMathlist) {
    function relation(parent, leaf) {
        const EXPR_NAME = {
        //    'array': 'should not happen',
            'numer': 'numerator',
            'denom': 'denominator',
            'index': 'index',
            'body': 'parent',
            'subscript': 'subscript',
            'superscript': 'superscript'
        }

        const PARENT_NAME = {
            'enclose': 'cross out', // FIX -- should base on type of enclose
            'leftright': 'fence',
            'surd': 'square root',
            'root': 'math field'
        }
        return (leaf.relation === 'body' ? PARENT_NAME[parent.type] : EXPR_NAME[leaf.relation]);
    }

    const oldPath = oldMathlist ? oldMathlist.path : [];
    const path = this.mathlist.path;
    const leaf = path[path.length - 1];
    let result = '';

    while (oldPath.length > path.length) {
        result += 'out of ' + relation(oldMathlist.parent(), oldPath[oldPath.length - 1]) + '; ';
        oldPath.pop();
    }
    if (!this.mathlist.isCollapsed()) {
        return speakableText(this, '', this.mathlist.getSelectedAtoms());
    }

    // announce start of denominator, etc
    const relationName = relation(this.mathlist.parent(), leaf);
    if (leaf.offset === 0) {
        result += (relationName ? 'start of ' + relationName : 'unknown') + ': ';
    }
    const atom = this.mathlist.sibling(Math.max(1, this.mathlist.extent));
    if (atom) {
        result += speakableText(this, '', atom);
    } else if (leaf.offset !== 0) { // don't say both start and end
        result += relationName ? 'end of ' + relationName : 'unknown';
    }
    return result;
}


function speakableText(mathfield, prefix, atoms) {
    const config = Object.assign({}, mathfield.config);
    config.textToSpeechMarkup = '';
    return prefix + MathAtom.toSpeakableText(atoms, config);
}

/**
 * Announce a change in selection or content via the aria-live region.
 * This is the default implementation for this function. It can be overridden
 * via `config.onAnnounce`
 * @param {object} target typically, a MathField
 * @param {string} command the command that invoked the change
 * @param {Atom[]} [oldMathlist=[]] the previous value of mathlist before the change
 * @param {Atom[]} [atomsToSpeak=[] ] 
 * @method MathField#_onAnnounce
 * @private
 */
 function _onAnnounce(target, command, oldMathlist, atomsToSpeak) {
//** Fix: the focus is the end of the selection, so it is before where we want it
    let liveText = '';
    // const command = moveAmount > 0 ? "right" : "left";

    if (command === 'plonk') {
        // Use this sound to indicate (minor) errors, for
        // example when a command has no effect.
        if (target.plonkSound) {
            target.plonkSound.load();
            target.plonkSound.play().catch(err => console.warn(err));
        }
        // As a side effect, reset the keystroke buffer
        target._resetKeystrokeBuffer();
    } else if (command === 'delete') {
        liveText = speakableText(target, 'deleted: ', atomsToSpeak);
    //*** FIX: could also be moveUp or moveDown -- do something different like provide context???
    } else if (command === 'focus' || /move/.test(command)) {
        //*** FIX -- should be xxx selected/unselected */
        liveText = (target.mathlist.isCollapsed() ? '' : 'selected: ') +
                    target._nextAtomSpeechText(oldMathlist);
    } else if (command === 'replacement') {
        // announce the contents
        liveText = speakableText(target, '', target.mathlist.sibling(0));
    } else if (command === 'line') {
        // announce the current line -- currently that's everything
        liveText = speakableText(target, '', target.mathlist.root);
        target.accessibleNode.innerHTML =
            '<math xmlns="http://www.w3.org/1998/Math/MathML">' +
                MathAtom.toMathML(target.mathlist.root, target.config) +
            '</math>';

        target.textarea.setAttribute('aria-label', 'after: ' + liveText)

        /*** FIX -- testing hack for setting braille ***/
        // target.accessibleNode.focus();
        // console.log("before sleep");
        // sleep(1000).then(() => {
        //     target.textarea.focus();
        //     console.log("after sleep");
        // });
    } else {
        liveText = atomsToSpeak ? speakableText(target, command + " ", atomsToSpeak) : command;
    }
    // aria-live regions are only spoken when it changes; force a change by
    // alternately using nonbreaking space or narrow nonbreaking space
    const ariaLiveChangeHack = /\u00a0/.test(target.ariaLiveText.textContent) ?
        ' \u202f ' : ' \u00a0 ';
    target.ariaLiveText.textContent = liveText + ariaLiveChangeHack;
    // this.textarea.setAttribute('aria-label', liveText + ariaLiveChangeHack);
}


MathField.prototype._announce = function(command, mathlist, atoms) {
    if (typeof this.config.onAnnounce === 'function') {
        this.config.onAnnounce(this, command, mathlist, atoms);
    }
}


MathField.prototype._onFocus = function() {
    if (this.blurred) {
        this.blurred = false;

        // The textarea may be a span (on mobile, for example), so check that
        // it has a focus() before calling it.
        if (this.textarea.focus) this.textarea.focus();
        if (this.config.virtualKeyboardMode === 'onfocus') {
            this.showVirtualKeyboard_();
        }
        Popover.updatePopoverPosition(this);
        if (this.config.onFocus) this.config.onFocus(this);
        this._render();
    }
}

MathField.prototype._onBlur = function() {
    if (!this.blurred) {
        this.blurred = true;
        this.ariaLiveText.textContent = '';
        if (this.config.virtualKeyboardMode === 'onfocus') {
            this.hideVirtualKeyboard_();
        }
        Popover.updatePopoverPosition(this);
        this._render();
        if (this.config.onBlur) this.config.onBlur(this);
    }
}

MathField.prototype._onResize = function() {
    this.element.classList.remove('ML__isNarrowWidth', 'ML__isWideWidth', 'ML__isExtendedWidth');
    if (window.innerWidth >= 1024) {
        this.element.classList.add('ML__isExtendedWidth');
    } else if (window.innerWidth >= 768) {
        this.element.classList.add('ML__isWideWidth');
    } else {
        this.element.classList.add('ML__isNarrowWidth');
    }
    Popover.updatePopoverPosition(this);
}


MathField.prototype.toggleKeystrokeCaption_ = function() {
    this.keystrokeCaptionVisible = !this.keystrokeCaptionVisible;
    this.keystrokeCaption.innerHTML = '';
    if (!this.keystrokeCaptionVisible) {
        this.keystrokeCaption.style.visibility = 'hidden';
    }
}


MathField.prototype._showKeystroke = function(keystroke) {
    const vb = this.keystrokeCaption;
    if (vb && this.keystrokeCaptionVisible) {
        const bounds = this.element.getBoundingClientRect();
        vb.style.left = bounds.left + 'px';
        vb.style.top = (bounds.top - 64) + 'px';
        vb.innerHTML = '<span>' +
            (Shortcuts.stringify(keystroke) || keystroke) +
            '</span>' + vb.innerHTML;
        vb.style.visibility = 'visible';
        setTimeout(function() {
            if (vb.childNodes.length > 0) {
                vb.removeChild(vb.childNodes[vb.childNodes.length - 1]);
            }
            if (vb.childNodes.length === 0) {
                vb.style.visibility = 'hidden';
            }
        }, 3000);
    }
}

/**
 * @param {string|string[]} command - A selector, or an array whose first element
 * is a selector, and whose subsequent elements are arguments to the selector.
 * Note that selectors do not include a final "_". They can be passed either 
 * in camelCase or kebab-case. So:
 * ```javascript
 * mf.$perform('selectAll');
 * mf.$perform('select-all');
 * ```
 * both calls are valid and invoke the same selector.
 * 
 * @method MathField#$perform
 */
MathField.prototype.perform = 
MathField.prototype.$perform = function(command) {
    if (!command) return false;
    let handled = false;
    let selector;
    let args = [];
    let dirty = false;
    if (Array.isArray(command)) {
        selector =  command[0];
        args = command.slice(1);
    } else {
        selector = command;
    }
    // Convert kebab case (like-this) to camel case (likeThis).
    selector = selector.replace(/-\w/g, (m) => m[1].toUpperCase() );

    selector += '_';

    if (typeof this.mathlist[selector] === 'function') {
        if (/^(delete|transpose|add)/.test(selector)) {
            this._resetKeystrokeBuffer();
        }

        if (/^(delete|transpose|add)/.test(selector) && this.mode !== 'command') {
            // Update the undo state to account for the current selection
            this.undoManager.pop();
            this.undoManager.snapshot(this.config);
        }
        this.mathlist[selector](...args);
        if (/^(delete|transpose|add)/.test(selector) && this.mode !== 'command') {
            this.undoManager.snapshot(this.config);
        }
        dirty = true;
        handled = true;
    } else if (typeof this[selector] === 'function') {
        dirty = this[selector](...args);

        handled = true;
    }

    // If the command changed the selection so that it is no longer 
    // collapsed, or if it was an editing command, reset the inline
    // shortcut buffer
    if (!this.mathlist.isCollapsed() || /^(transpose|paste|complete|((moveToNextChar|moveToPreviousChar|extend).*))_$/.test(selector)) {
        this._resetKeystrokeBuffer();
    }

    // Render the mathlist
    if (dirty) {
        this._render();
    }

    return handled;
}

/**
 * Perform a command, but:
 * * focus the mathfield
 * * provide haptic and audio feedback
 * This is used by the virtual keyboard when command keys (delete, arrows, etc..)
 * are pressed.
 * @param {string} command
 */
MathField.prototype.performWithFeedback_ = function(command) {
    this.focus();

    if (this.config.keypressVibration && navigator.vibrate) {
        navigator.vibrate(HAPTIC_FEEDBACK_DURATION);
    }

    // Convert kebab case to camel case.
    command = command.replace(/-\w/g, (m) => m[1].toUpperCase() );

    if (command === 'moveToNextPlaceholder' ||
        command === 'moveToPreviousPlaceholder' ||
        command === 'complete') {
        if (this.returnKeypressSound) {
            this.returnKeypressSound.load();
            this.returnKeypressSound.play().catch(err => console.warn(err));
        } else if (this.keypressSound) {
            this.keypressSound.load();
            this.keypressSound.play().catch(err => console.warn(err));
        }
    } else if (command === 'deletePreviousChar' ||
        command === 'deleteNextChar' ||
        command === 'deletePreviousWord' ||
        command === 'deleteNextWord' ||
        command === 'deleteToGroupStart' ||
        command === 'deleteToGroupEnd' ||
        command === 'deleteToMathFieldStart' ||
        command === 'deleteToMathFieldEnd') {
            if (this.deleteKeypressSound) {
                this.deleteKeypressSound.load();
                this.deleteKeypressSound.play().catch(err => console.warn(err));
            } else if (this.keypressSound) {
                this.keypressSound.load();
                this.keypressSound.play().catch(err => console.warn(err));
            }
    } else if (this.keypressSound) {
        this.keypressSound.load();
        this.keypressSound.play().catch(err => console.warn(err));
    }

    return this.perform(command);
}



/**
 * Convert the atoms before the anchor to 'text' mode
 * @param {number} count - how many atoms back to look at
 * @param {function} until - callback to indicate when to stop
 */
MathField.prototype.convertLastAtomsToText_ = function(count, until) {
    if (typeof count === 'function') {
        until = count;
        count = Infinity;
    }
    if (count === undefined) count = Infinity;
    let i = 0;
    let done = false;
    this.mathlist.contentWillChange();
    while (!done) {
        const atom = this.mathlist.sibling(i);
        done = count === 0 || !atom || atom.mode !== 'math' || 
            !/mord|textord|mpunct/.test(atom.type) ||
            atom.superscript || atom.subscript || 
            (until && !until(atom));
        if (!done) {
            atom.type = 'textord';
            atom.mode = 'text';
            atom.fontFamily = 'main';
            atom.latex = atom.body;
        }
        i -= 1;
        count -= 1;
    }
    this.mathlist.contentDidChange();
}

/**
 * Convert the atoms before the anchor to 'math' mode 'mord'
 * @param {number} count - how many atoms back to look at
 * @param {function} until - callback to indicate when to stop
 */
MathField.prototype.convertLastAtomsToMath_ = function(count, until) {
    if (typeof count === 'function') {
        until = count;
        count = Infinity;
    }
    if (count === undefined) count = Infinity;

    this.mathlist.contentWillChange();

    let i = 0;
    let done = false;
    while (!done) {
        const atom = this.mathlist.sibling(i);
        done = count === 0 || !atom || atom.mode !== 'text' || 
            atom.body === ' ' ||
            (until && !until(atom));
        if (!done) {
            atom.type = 'mord';
            atom.mode = 'math';
            atom.fontFamily = 'mathit';
        }
        i -= 1;
        count -= 1;
    }

    this.removeIsolatedSpace_();

    this.mathlist.contentDidChange();
}

/**
 * Going backwards from the anchor, if a text zone consisting of a single
 * space character is found (i.e. it is surrounded by math zone), 
 * remove it.
 */
MathField.prototype.removeIsolatedSpace_ = function() {
    let i = 0;
    while (this.mathlist.sibling(i) && this.mathlist.sibling(i).mode === 'math') {
        i -= 1;
    }

    // If the atom before the last one converted is a
    // text mode space, preceded by a math mode atom,
    // remove the space
    if (this.mathlist.sibling(i) && 
        this.mathlist.sibling(i).mode === 'text' && 
        this.mathlist.sibling(i).body === ' ' && (
            !this.mathlist.sibling(i - 1) || 
            this.mathlist.sibling(i - 1).mode === 'math'
    )) {
        this.mathlist.contentWillChange();
        this.mathlist.siblings().splice(i - 1, 1);
        this.mathlist.contentDidChange();
        // We need to adjust the selection after doing some surgery on the atoms list
        // But we don't want to receive selection notification changes 
        // which could have a side effect of changing the mode :(
        const save = this.mathlist.suppressChangeNotifications;
        this.mathlist.suppressChangeNotifications = true;
        this.mathlist.setSelection(this.mathlist.anchorOffset() - 1);
        this.mathlist.suppressChangeNotifications = save;
    }
}


/**
 * Return the characters before anchor that could potentially be turned
 * into text mode.
 * This excludes things like 'mop' (e.g. \sin)
 * @return {string}
 * @method MathField#getTextBeforeAnchor_
 * @private
 */
MathField.prototype.getTextBeforeAnchor_ = function() {
    // Going backwards, accumulate
    let result = '';
    let i = 0;
    let done = false;
    while (!done) {
        const atom = this.mathlist.sibling(i);
        done = !atom || !/mord|textord|mpunct/.test(atom.type);
        if (!done) {
            result = atom.body + result;
        }
        i -= 1;
    }
    return result;
}


/**
 * Consider whether to switch mode give the content before the anchor
 * and the character being input
 * 
 * @param {string} keystroke
 * @param {Event} evt - a Event corresponding to the keystroke
 * @method MathField#smartMode_
 * @return {boolean} true if the mode should change
 * @private
 */
MathField.prototype.smartMode_ = function(keystroke, evt) {
    if (this.smartModeSuppressed) return false;
    if (this.mathlist.endOffset() < this.mathlist.siblings().length - 1) return false;
    if (!evt || evt.ctrlKey || evt.metaKey) return false;
    const c = Keyboard.eventToChar(evt);
    if (c.length > 1) return false;   // Backspace, Left, etc...
    if (this.mathlist.isCollapsed()) {
        const context = this.getTextBeforeAnchor_() + c;
        if (this.mode === 'text') {
            // We're in text mode. Should we switch to math?

            if (keystroke === 'Esc' || /[/^_\\]/.test(c)) {
                // If this is a command for a fraction, superscript or subscript,
                // of the '\' command mode key
                // switch to 'math'
                return true;
            }

            // If this is a closing matching fence
            // switch to 'math' mode
            const lFence = {')' : '(', '}' : '{', ']' : '['}[c];
            if (lFence && this.mathlist.parent() && 
                this.mathlist.parent().type === 'leftright' &&
                this.mathlist.parent().leftDelim === lFence) {
                return true;
            }


            if (/(^|[^a-zA-Z])(a|I)[ ]$/.test(context)) {
                // Single letters that are valid words in the current language
                // Do nothing. @todo: localization
                return false;
            }

            if (/(^|[^a-zA-Z])[a-zA-Z][ ]$/.test(context)) {
                // An isolated letter, followed by a space:
                // Convert the letter to math, stay in text mode.
                this.convertLastAtomsToMath_(1);
                return false;
            }

            if (/\.\S$/.test(context)) {
                // A period followed by something other than space
                // We thought this was a text period, but turns out it's not
                // Turn it into a \cdot
                const atom = this.mathlist.sibling(0);
                atom.body = '⋅';        // centered dot
                atom.fontFamily = 'mathrm';
                atom.latex = '\\cdot';
                atom.mode = 'math';
                atom.type = 'mord';

                return true;
            }

            if (/(^|\s)[a-zA-Z][^a-zA-Z]$/.test(context)) {
                // Single letter (x), followed by a non-letter (>, =...)
                this.convertLastAtomsToMath_(1);
                this.removeIsolatedSpace_();
                return true;
            }

            if (/\.[0-9]$/.test(context)) {
                // If the new character is a digit, 
                // and it was preceded by a dot (which may have been converted
                // to text)
                // turn the dot back into 'math'
                this.convertLastAtomsToMath_(1);
                return true;
            }

            if (/[(][0-9+\-.]$/.test(context)) {
                // An open paren followed by a number
                // Turn the paren back to math and switch.
                this.convertLastAtomsToMath_(1);
                this.removeIsolatedSpace_();
                return true;
            }

            if (/[(][a-z][,;]$/.test(context)) {
                // An open paren followed by a single letter, then a "," or ";"
                // Turn the paren back and letter to math and switch.
                this.convertLastAtomsToMath_(2);
                this.removeIsolatedSpace_();
                return true;
            }

            // The tests above can look behind and change what had previously
            // been entered. Now, let's just look at the typed character.
            if (/[0-9+\-=><*|]$/.test(c)) {
                // If this new character looks like a number,
                // or a relational operator (=, <, >)
                // or a "*" or "|"
                // (note that <=, >=, etc... are handled separately as shortcuts)
                // switch to 'math'
                this.removeIsolatedSpace_();
                return true;
            }


            // /(?<match>[0-9>=<+-/()]+)$/

        } else {
            // We're in math mode. Should we switch to text?
            if (keystroke === 'Spacebar') {
                this.convertLastAtomsToText_(a => /[a-z][:,;.]$/.test(a.body));
                return true;
            }
            if (/[a-zA-Z]{3,}$/.test(context) && !/dxd$/.test(context)) {
                // A sequence of three characters
                // (except for some exceptions)
                // Convert them to text.
                this.convertLastAtomsToText_(a => 
                    /[a-zA-Z:,;.]/.test(a.body));
                return true;
            }
            if (/(^|\W)(if|If)$/i.test(context)) {
                // @todo localization
                this.convertLastAtomsToText_(1);
                return true;
            }
            if (/\?|\./.test(c)) {
                // If the last character is a period or question mark, 
                // turn it to 'text'
                return true;
            }
        }
    } else {
        // There is a selection
        // @todo handle some keys: /, ^
    }
    return false;
}





/**
 * @param {string} keystroke
 * @param {Event} evt - optional, an Event corresponding to the keystroke
 * @method MathField#_onKeystroke
 * @private
 */
MathField.prototype._onKeystroke = function(keystroke, evt) {
    // 1. Display the keystroke in the keystroke panel (if visible)
    this._showKeystroke(keystroke);

    // 2. Reset the timer for the keystroke buffer reset
    clearTimeout(this.keystrokeBufferResetTimer);

    // 3. Give a chance to the custom keystroke handler to intercept the event
    if (this.config.onKeystroke && !this.config.onKeystroke(this, keystroke, evt)) {
        if (evt && evt.preventDefault) {
            evt.preventDefault();
            evt.stopPropagation();
        }
        return false;
    }

    // 4. Let's try to find a matching shortcut or command
    let shortcut;
    let stateIndex;
    let selector;
    let resetKeystrokeBuffer = false;

    // 4.1 Check if the keystroke, prefixed with the previously typed keystrokes,
    // would match a long shortcut (i.e. '~~')
    // Ignore the key if command or control is pressed (it may be a shortcut, 
    // see 4.3)
    if (this.mode !== 'command' && (!evt || (!evt.ctrlKey && !evt.metaKey))) {
        const c = Keyboard.eventToChar(evt);
        // The Backspace key will be handled as a delete command later (5.4)
        // const c = Keyboard.eventToChar(evt);
        if (c !== 'Backspace') {
            if (!c || c.length > 1) {
                // It was a non-alpha character (PageUp, End, etc...)
                this._resetKeystrokeBuffer();
            } else {
                // Find the longest substring that matches a shortcut
                const candidate = this.keystrokeBuffer + c;
                let i = 0;
                while (!shortcut && i < candidate.length) {
                    const siblings = this.keystrokeBufferStates[i] ? ParserModule.parseTokens(
                        Lexer.tokenize(this.keystrokeBufferStates[i].latex), 
                        this.config.default, null, this.config.macros) : 
                        this.mathlist.siblings();
                    shortcut = Shortcuts.forString(siblings,
                        candidate.slice(i), this.config);
                    i += 1;
                }
                stateIndex = i - 1;
                this.keystrokeBuffer += c;
                this.keystrokeBufferStates.push(this.undoManager.save());
                if (Shortcuts.startsWithString(candidate, this.config).length <= 1) {
                    resetKeystrokeBuffer = true;
                } else {
                    if (this.config.inlineShortcutTimeout) {
                        // Set a timer to reset the shortcut buffer
                        this.keystrokeBufferResetTimer = setTimeout(() => {
                            this._resetKeystrokeBuffer();
                        }, this.config.inlineShortcutTimeout);
                    }
                }
            }
        }
    }


    // 4.2. Should we switch mode?
    // Need to check this before determing if there's a valid shortcut
    // since if we switch to math mode, we may want to apply the shortcut
    // e.g. "slope = rise/run"
    if (this.config.smartMode) {
        const previousMode = this.mode;
        if (shortcut) {
            // If we found a shortcut (e.g. "alpha"),
            // switch to math mode and insert it.
            this.mode = 'math'
        } else if (this.smartMode_(keystroke, evt)) {
            this.mode = {'math':'text', 'text':'math'}[this.mode];
            selector = '';
        }
        // Notify of mode change
        if (this.mode !== previousMode && typeof this.config.onModeChange === 'function') {
            this.config.onModeChange(this, this.mode)
        }
    }

    // 4.3 Check if this matches a keystroke shortcut
    // Need to check this **after** checking for inline shortcuts because
    // shift+backquote is a keystroke that inserts "\~"", but "~~" is a 
    // shortcut for "\approx" and needs to have priority over shift+backquote
    if (!shortcut && !selector) {
        selector = Shortcuts.selectorForKeystroke(this.mode, keystroke);
    }

    // No shortcut :( We're done.
    if (!shortcut && !selector) return true;

    // 5. Perform the action matching this shortcut

    // 5.1 Remove any error indicator (wavy underline) on the current command 
    // sequence (if there are any)
    this.mathlist.decorateCommandStringAroundInsertionPoint(false);

    // 5.2 If we have a `moveAfterParent` selector (usually triggered with 
    // `spacebar), and we're at the end of a smart fence, close the fence with 
    // an empty (.) right delimiter
    const parent = this.mathlist.parent();
    if (selector === 'moveAfterParent' && parent && 
        parent.type === 'leftright' && 
        this.mathlist.endOffset() === this.mathlist.siblings().length - 1 &&
        this.mathlist._insertSmartFence('.')) {
            // Pressing the space bar (moveAfterParent selector) when at the end 
            // of a potential smartfence will close it as a semi-open fence
        selector = '';
        this._render(); // Re-render the closed smartfence
    }

    // 5.3 If this is the Spacebar and we're just before or right after 
    // a text zone, insert the space inside the text zone
    if (this.mode === 'math' && keystroke === 'Spacebar') {
        const nextSibling = this.mathlist.sibling(1);
        const previousSibling = this.mathlist.sibling(-1);
        if ((nextSibling && nextSibling.mode === 'text') || 
            (previousSibling && previousSibling.mode === 'text')) {
            this.mathlist.insert(' ', { mode: 'text' });
        } 
    }

    // 5.4 If there's a selector, perform it.
    if ((selector && !this.perform(selector)) || shortcut) {

        // // 6.5 insert the shortcut
        if (shortcut) {
            // If the shortcut is a mandatory escape sequence (\}, etc...) 
            // don't make it undoable, this would result in syntactically incorrect
            // formulas
            if (!/^(\\{|\\}|\\[|\\]|\\@|\\#|\\$|\\%|\\^|\\_|\\backslash)$/.test(shortcut)) {
                // To enable the substitution to be undoable,
                // insert the character before applying the substitution
                this.mathlist.insert(Keyboard.eventToChar(evt), {
                    suppressChangeNotifications: true,
                    mode: this.mode
                });
                const saveMode = this.mode;

                // Create a snapshot with the inserted character
                this.undoManager.snapshotAndCoalesce(this.config);

                // Revert to the state before the beginning of the shortcut
                // (restore doesn't change the undo stack)
                this.undoManager.restore(this.keystrokeBufferStates[stateIndex], 
                    {...this.config, suppressChangeNotifications: true });
                this.mode = saveMode;
            }

            this.mathlist.contentWillChange();
            const save = this.mathlist.suppressChangeNotifications;
            this.mathlist.suppressChangeNotifications = true;

            // Insert the substitute, possibly as a smart fence
            if (!this.mathlist._insertSmartFence(shortcut)) {
                this.mathlist.insert(shortcut, {format: 'latex', mode: this.mode});
            }

            // Check if as a result of the substitution there is now an isolated
            // (text mode) space (surrounded by math). In which case, remove it.
            this.removeIsolatedSpace_();

            this.mathlist.suppressChangeNotifications = save;
            this.mathlist.contentDidChange();

            this.undoManager.snapshot(this.config);
            this._render();
            this._announce('replacement');

            // If we're done with the shortcuts (found a unique one), reset it.
            if (resetKeystrokeBuffer) {
                this._resetKeystrokeBuffer();
            }
        }
    }

    // 6. Keystroke has been handled, if it wasn't caught in the default
    // case, so prevent propagation
    if (evt && evt.preventDefault) {
        evt.preventDefault();
        evt.stopPropagation();
    }
    return false;
}





/**
 * This handler is invoked when text has been typed, pasted in or input with
 * an input method. As a result, `text` can be a sequence of characters to
 * be inserted.
 * @param {string} text
 * @param {object} options
 * @param {boolean} options.focus - If true, the mathfield will be focused
 * @param {boolean} options.feedback - If true, provide audio and haptic feedback
 * @param {boolean} options.simulateKeystroke - If true, generate some synthetic
 * keystrokes (useful to trigger inline shortcuts, for example)
 * @param {boolean} options.commandMode - If true, switch to command mode if
 * necessary, then insert text
 */
MathField.prototype._onTypedText = function(text, options) {
    options = options || {};

    // Focus, then provide audio and haptic feedback
    if (options.focus) this.focus();
    if (options.feedback) {
         if (this.config.keypressVibration && navigator.vibrate) {
            navigator.vibrate(HAPTIC_FEEDBACK_DURATION);
        }
        if (this.keypressSound) {
            this.keypressSound.load();            
            this.keypressSound.play().catch(err => console.warn(err));
        }
    }

    if (options.commandMode && this.mode !== 'command') {
        this.enterCommandMode_();
    }

    // Remove any error indicator on the current command sequence
    // (if there is one)
    this.mathlist.decorateCommandStringAroundInsertionPoint(false);

    if (options.simulateKeystroke) {
        // for (const c of text) {
        const c = text.charAt(0);
        const ev = Keyboard.charToEvent(c);
        if (!this.$keystroke(Keyboard.keyboardEventToString(ev), ev)) return;
        // }
    }


    // Insert the specified text at the current insertion point.
    // If the selection is not collapsed, the content will be deleted first.

    let popoverText = '';
    let displayArrows = false;

    if (this.pasteInProgress) {
        this.pasteInProgress = false;
        // This call was made in response to a paste event.
        // Interpret `text` as a 'smart' expression (could be LaTeX, could be 
        // UnicodeMath)
        this.mathlist.insert(text, {
            smartFence: this.config.smartFence, 
            mode: 'math'
        });

    } else {
        // Decompose the string into an array of graphemes.
        // This is necessary to correctly process what is displayed as a single
        // glyph (a grapheme) but which is composed of multiple Unicode 
        // codepoints. This is the case in particular for some emojis, such as
        // those with a skin tone modifier, the country flags emojis or 
        // compound emojis such as the professional emojis, including the
        // David Bowie emoji: 👨🏻‍🎤
        const graphemes = GraphemeSplitter.splitGraphemes(text);
        for (const c of graphemes) {
            if (this.mode === 'command') {
                this.mathlist.removeSuggestion();
                this.suggestionIndex = 0;
                const command = this.mathlist.extractCommandStringAroundInsertionPoint();
                const suggestions = Definitions.suggest(command + c);
                displayArrows = suggestions.length > 1;
                if (suggestions.length === 0) {
                    this.mathlist.insert(c, {mode: 'command'});
                    if (/^\\[a-zA-Z\\*]+$/.test(command + c)) {
                        // This looks like a command name, but not a known one
                        this.mathlist.decorateCommandStringAroundInsertionPoint(true);
                    }
                    Popover.hidePopover(this);
                } else {
                    this.mathlist.insert(c, {mode: 'command'});
                    if (suggestions[0].match !== command + c) {
                        this.mathlist.insertSuggestion(suggestions[0].match,
                            -suggestions[0].match.length + command.length + 1);
                    }
                    popoverText = suggestions[0].match;
                }
            } else if (this.mode === 'math') {
                // Some characters are mapped to commands. Handle them here.
                // This is important to handle synthetic text input and
                // non-US keyboards, on which, fop example, the '^' key is
                // not mapped to  'Shift-Digit6'.
                const selector = {
                    '^': 'moveToSuperscript',
                    '_': 'moveToSubscript',
                    ' ': 'moveAfterParent'
                }[c];
                if (selector) {
                    if (selector === 'moveToSuperscript') {
                        if (this._superscriptDepth() >= this.config.scriptDepth[1]) {
                            this._announce('plonk');
                            return;
                        }
                    } else if (selector === 'moveToSubscript') {
                        if (this._subscriptDepth() >= this.config.scriptDepth[0]) {
                            this._announce('plonk');
                            return;
                        }
                    }
                    this.perform(selector);
                } else {
                    if (this.config.smartSuperscript && 
                        this.mathlist.relation() === 'superscript' &&
                        /[0-9]/.test(c) && 
                        this.mathlist.siblings().filter(x => x.type !== 'first').length === 0) { 
                            // We are inserting a digit into an empty superscript
                            // If smartSuperscript is on, insert the digit, and 
                            // exit the superscript.
                            this.mathlist.insert(c, { mode: 'math' });
                            this.mathlist.moveAfterParent_();

                    } else if (!this.mathlist._insertSmartFence(c)) {
                        this.mathlist.insert(c, { mode: 'math' });
                    }
                }
            } else if (this.mode === 'text') {
                this.mathlist.insert(c, { mode: 'text' });

            }
        }
    }

    if (this.mode !== 'command') {
        this.undoManager.snapshotAndCoalesce(this.config);
    }

    // Render the mathlist
    this._render();

    // Since the location of the popover depends on the position of the caret
    // only show the popover after the formula has been rendered and the
    // position of the caret calculated
    Popover.showPopoverWithLatex(this, popoverText, displayArrows);
}


/**
 * Return a hash (32-bit integer) representing the content of the mathfield
 * (but not the selection state)
 */
MathField.prototype._hash = function() {
    let result = 0;
    const str = this.mathlist.root.toLatex(false);
    for (let i = 0; i < str.length; i++) {
        result = result * 31 + str.charCodeAt(i);
        result = result | 0;   // Force it to a 32-bit number
    }
    return Math.abs(result);
}

/**
 * Lay-out the math field and generate the DOM.
 *
 * This is usually done automatically, but if the font-size, or other geometric
 * attributes are modified, outside of MathLive, this function may need to be
 * called explicitly.
 *
 * @method MathField#render
 * @private
 */
MathField.prototype._render = function(renderOptions) {
    renderOptions = renderOptions || {};

    //
    // 1. Stop and reset read aloud state
    //
    if (!window.mathlive) window.mathlive = {};

    //
    // 2. Validate selection
    //
    if (!this.mathlist.anchor()) {
        console.warn('Invalid selection, resetting it. ' + MathPath.pathToString(this.mathlist.path));
        this.mathlist.path = [{relation: 'body', offset: 0}];
    }

    //
    // 3. Update selection state and blinking cursor (caret)
    //
    this.mathlist.forEach( a => {
            a.caret = '';
            a.isSelected = false;
        } );

    const hasFocus = this.hasFocus();
    if (this.mathlist.isCollapsed()) {
        this.mathlist.anchor().caret = hasFocus ? this.mode : '';
    } else {
        this.mathlist.forEachSelected( a => { a.isSelected = true });
    }

    //
    // 4. Create spans corresponding to the updated mathlist
    //
    const spans = MathAtom.decompose(
        {
            mathstyle: 'displaystyle',
            generateID: {
                // Using the hash as a seed for the ID
                // keeps the IDs the same until the content of the field changes.
                seed: this._hash(),
                // The `groupNumbers` flag indicates that extra spans should be generated
                // to represent group of atoms, for example, a span to group
                // consecutive digits to represent a number.
                groupNumbers: renderOptions.forHighlighting,
            },
            macros: this.config.macros
        }, this.mathlist.root);

    //
    // 5. Construct struts around the spans
    //

    const base = Span.makeSpan(spans, 'ML__base');
    base.attributes = {
        // Hint to screen readers to not attempt to read this span
        // They should use instead the 'aria-label' below.
        'aria-hidden': 'true'
    }

    const topStrut = Span.makeSpan('', 'ML__strut')
    topStrut.setStyle('height', base.height, 'em');
    const struts = [topStrut];
    if (base.depth !== 0) {
        const bottomStrut = Span.makeSpan('', 'ML__strut--bottom');
        bottomStrut.setStyle('height', base.height + base.depth, 'em');
        bottomStrut.setStyle('vertical-align', -base.depth, 'em');
        struts.push(bottomStrut);
    }
    struts.push(base);
    const wrapper = Span.makeSpan(struts, 'ML__mathlive');

    //
    // 6. Generate markup and accessible node
    //

    this.field.innerHTML = wrapper.toMarkup(0, this.config.horizontalSpacingScale);
    this.field.classList.toggle('ML__focused', hasFocus);
    // Probably want to generate content on the fly depending on what to speak
    this.accessibleNode.innerHTML =
       "<math xmlns='http://www.w3.org/1998/Math/MathML'>" +
           MathAtom.toMathML(this.mathlist.root, this.config) +
       "</math>";
    //this.ariaLiveText.textContent = "";

    //
    // 7. Calculate selection rectangle
    //

    const selectedNodes = this.field.querySelectorAll('.ML__selected');
    if (selectedNodes && selectedNodes.length > 0) {
        const selectionRect = { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
        // Calculate the union of the bounds of all the selected spans
        selectedNodes.forEach(node => {
            if (node.classList.contains('ML__selected')) {
                const bounds = node.getBoundingClientRect();
                if (bounds.left < selectionRect.left) selectionRect.left = bounds.left;
                if (bounds.right > selectionRect.right) selectionRect.right = bounds.right;
                if (bounds.bottom > selectionRect.bottom) selectionRect.bottom = bounds.bottom;
                if (bounds.top < selectionRect.top) selectionRect.top = bounds.top;
            }
        });
        const fieldRect = this.field.getBoundingClientRect();
        const selectionElement = document.createElement('div');
        selectionElement.classList.add('ML__selection');
        selectionElement.style.position = 'absolute';
        selectionElement.style.left = (selectionRect.left - fieldRect.left) + 'px';
        selectionElement.style.top = (selectionRect.top - fieldRect.top) + 'px';
        selectionElement.style.width = (selectionRect.right - selectionRect.left) + 'px';
        selectionElement.style.height = (selectionRect.bottom - selectionRect.top) + 'px';
        this.field.insertBefore(selectionElement, this.field.childNodes[0])
    }


    //
    // 8. Scroll view
    //

    this.scrollIntoView_();
}


MathField.prototype._onPaste = function() {
    // Make note we're in the process of pasting. The subsequent call to
    // onTypedText() will take care of interpreting the clipboard content
    this.pasteInProgress = true;
    return true;
}

MathField.prototype._onCut = function() {
    // Clearing the selection will have the side effect of clearing the
    // content of the textarea. However, the textarea value is what will
    // be copied to the clipboard, so defer the clearing of the selection
    // to later, after the cut operation has been handled.
    setTimeout(function() {
        this.clearSelection();
        this._render();
    }.bind(this), 0);
    return true;
}

MathField.prototype._onCopy = function(e) {
    if (this.mathlist.isCollapsed()) {
        e.clipboardData.setData('text/plain', this.$text('latex-expanded'));
        e.clipboardData.setData('application/json', this.$text('json'));
        e.clipboardData.setData('application/xml', this.$text('mathML'));
    } else {
        e.clipboardData.setData('text/plain', this.$selectedText('latex-expanded'));
        e.clipboardData.setData('application/json', this.$selectedText('json'));
        e.clipboardData.setData('application/xml', this.$selectedText('mathML'));
    }

    // Prevent the current document selection from being written to the clipboard.
    e.preventDefault();
}


MathField.prototype.formatMathlist = function(root, format) {
    format = format || 'latex';
    let result = '';
    if (format === 'latex' || format === 'latex-expanded') {
        result = root.toLatex(format === 'latex-expanded');

    } else if (format === 'mathML') {
        result = root.toMathML(this.config);

    } else if (format === 'spoken') {
        result = MathAtom.toSpeakableText(root, this.config);

    } else if (format === 'spoken-text') {
        const save = this.config.textToSpeechMarkup;
        this.config.textToSpeechMarkup = '';
        result = MathAtom.toSpeakableText(root, this.config);
        this.config.textToSpeechMarkup = save;

    } else if (format === 'spoken-ssml') {
        const save = this.config.textToSpeechMarkup;
        this.config.textToSpeechMarkup = 'ssml';
        result = MathAtom.toSpeakableText(root, this.config);
        this.config.textToSpeechMarkup = save;

    } else if (format === 'json') {
        const json = MathAtom.toAST(root, this.config);
        result = JSON.stringify(json);
    
    } else if (format === 'ASCIIMath') {
        result = toASCIIMath(root, this.config);

    } else {
        console.warn('Unknown format :', format);
    }

    return result;
}




//
// PUBLIC API
//

/**
 * Return a textual representation of the mathfield.
 * @param {string} [format='latex']. One of
 *    * `'latex'`
 *    * `'latex-expanded'` : all macros are recursively expanded to their definition
 *    * `'spoken'`
 *    * `'spoken-text'`
 *    * `'spoken-ssml'`
 *    * `'mathML'`
 *    * `'json'`
 * @return {string}
 * @method MathField#$text
 */
MathField.prototype.text = 
MathField.prototype.$text = function(format) {
    return this.formatMathlist(this.mathlist.root, format);
}

/**
 * Return a textual representation of the selection in the mathfield.
 * @param {string} [format='latex']. One of
 *    * `'latex'`
 *    * `'latex-expanded'` : all macros are recursively expanded to their definition
 *    * `'spoken'`
 *    * `'spoken-text'`
 *    * `'spoken-ssml'`
 *    * `'mathML'`
 *    * `'json'`
 * @return {string}
 * @method MathField#$selectedText
 */
MathField.prototype.selectedText = 
MathField.prototype.$selectedText = function(format) {
    const atoms = this.mathlist.getSelectedAtoms();
    if (!atoms) return '';
    const root = MathAtom.makeRoot(atoms[0].mode, atoms);
    return this.formatMathlist(root, format);
}


/**
 * Return true if the length of the selection is 0, that is, if it is a single
 * insertion point.
 * @return {boolean}
 * @method MathField#$selectionIsCollapsed
 */
MathField.prototype.selectionIsCollapsed = 
MathField.prototype.$selectionIsCollapsed = function() {
    return this.mathlist.isCollapsed();
}

/**
 * Return the depth of the selection group. If the selection is at the root level,
 * returns 0. If the selection is a portion of the numerator of a fraction
 * which is at the root level, return 1. Note that in that case, the numerator
 * would be the "selection group".
 * @return {number}
 * @method MathField#$selectionDepth
 */
MathField.prototype.selectionDepth = 
MathField.prototype.$selectionDepth = function() {
    return this.mathlist.path.length;
}

MathField.prototype._superscriptDepth = function() {
    let result = 0;
    let i = 0;
    let atom = this.mathlist.ancestor(i);
    let wasSuperscript = false;
    while (atom) {
        if (atom.superscript || atom.subscript) {
            result += 1;
        }
        if (atom.superscript) {
            wasSuperscript = true;
        } else if (atom.subscript) {
            wasSuperscript = false;
        }
        i += 1;
        atom = this.mathlist.ancestor(i);
    }
    return wasSuperscript ? result : 0;
}

MathField.prototype._subscriptDepth = function() {
    let result = 0;
    let i = 0;
    let atom = this.mathlist.ancestor(i);
    let wasSubscript = false;
    while (atom) {
        if (atom.superscript || atom.subscript) {
            result += 1;
        }
        if (atom.superscript) {
            wasSubscript = false;
        } else if (atom.subscript) {
            wasSubscript = true;
        }
        i += 1;
        atom = this.mathlist.ancestor(i);
    }
    return wasSubscript ? result : 0;
}


/**
 * Return true if the selection starts at the beginning of the selection group.
 * @return {boolean}
 * @method MathField#$selectionAtStart
 */
MathField.prototype.selectionAtStart = 
MathField.prototype.$selectionAtStart = function() {
    return this.mathlist.startOffset() === 0;
}

/**
 * Return true if the selection extends to the end of the selection group.
 * @return {boolean}
 * @method MathField#$selectionAtEnd
 */
MathField.prototype.selectionAtEnd = 
MathField.prototype.$selectionAtEnd = function() {
    return this.mathlist.endOffset() >= this.mathlist.siblings().length - 1;
}


/**
 *  True if the entire group is selected
 * */
MathField.prototype.groupIsSelected = function() {
    return this.mathlist.startOffset() === 0 && 
        this.mathlist.endOffset() >= this.mathlist.siblings().length - 1;
}

/**
 * If `text` is not empty, sets the content of the mathfield to the
 * text interpreted as a LaTeX expression.
 * If `text` is empty (or omitted), return the content of the mahtfield as a
 * LaTeX expression.
 * @param {string} text
 * 
 * @param {Object.<string, any>} options
 * @param {boolean} options.suppressChangeNotifications - If true, the
 * handlers for the contentWillChange and contentDidChange notifications will 
 * not be invoked. Default `false`.
 * 
 * @return {string}
 * @method MathField#$latex
 */
MathField.prototype.latex = 
MathField.prototype.$latex = function(text, options) {
    if (text) {
        const oldValue = this.mathlist.root.toLatex();
        if (text !== oldValue) {
            options = options || {};
            this.mathlist.insert(text, Object.assign({}, this.config, {
                insertionMode: 'replaceAll',
                selectionMode: 'after',
                format: 'latex',
                mode: 'math',
                suppressChangeNotifications: options.suppressChangeNotifications
            }));
            this.undoManager.snapshot(this.config);
            this._render();
        }
        return text;
    }

    // Return the content as LaTeX
    return this.mathlist.root.toLatex();
}


/**
 * Return the DOM element associated with this mathfield.
 * 
 * Note that `this.$el().mathfield = this`
 * @return {Element}
 * @method MathField#$el
 */
MathField.prototype.el = 
MathField.prototype.$el = function() {
    return this.element;
}

MathField.prototype.undo_ = MathField.prototype.undo = function() {
    this.complete_();

    // Undo to the previous state
    this.undoManager.undo(this.config);
    return true;
}

MathField.prototype.redo_ = MathField.prototype.redo = function() {
    this.complete_();
    this.undoManager.redo(this.config);
    return true;
}


MathField.prototype.scrollIntoView_ = MathField.prototype.scrollIntoView = function() {
    // @todo
    return false;
}

MathField.prototype.scrollToStart_ = MathField.prototype.scrollToStart = function() {
    // @todo
    return true;
}

MathField.prototype.scrollToEnd_ = MathField.prototype.scrollToEnd = function() {
    // @todo
    return true;
}

/**
 *
 * @method MathField#enterCommandMode_
 * @private
 */
MathField.prototype.enterCommandMode_ = function() {
    // Remove any error indicator on the current command sequence (if there is one)
    this.mathlist.decorateCommandStringAroundInsertionPoint(false);

    this.mathlist.removeSuggestion();
    Popover.hidePopover(this);
    this.suggestionIndex = 0;

    // Switch to the command mode keyboard layer
    if (this.virtualKeyboardVisible) {
        this.switchKeyboardLayer_('lower-command');
    }

    this.mathlist.insert('\u001b', {mode: 'math'});
    return true;
}


MathField.prototype.copyToClipboard_ = function() {
    this.focus();
    // If the selection is empty, select the entire field before
    // copying it.
    if (this.mathlist.isCollapsed()) {
        this.select();
    }
    document.execCommand('copy');
    return false;
}

MathField.prototype.cutToClipboard_ = function() {
    this.focus();
    document.execCommand('cut');
    return true;
}

MathField.prototype.pasteFromClipboard_ = function() {
    this.focus();
    document.execCommand('paste');
    return true;
}


/**
 * This method can be invoked as a selector with {@linkcode MathField#$perform $perform("insert")}
 * or called explicitly.
 * 
 * It will insert the specified block of text at the current insertion point,
 * according to the insertion mode specified. 
 * 
 * After the insertion, the selection will be set according to the `selectionMode`.
 * @param {string} s - The text to be inserted
 * 
 * @param {Object.<string, any>} [options={}]
 * 
 * @param {string} options.selectionMode - Describes where the selection
 * will be after the insertion:
 *    * `'placeholder'`: the selection will be the first available placeholder
 * in the item that has been inserted (default)
 *    * `'after'`: the selection will be an insertion point after the item that
 * has been inserted,
 *    * `'before'`: the selection will be an insertion point before
 * the item that has been inserted
 *    * `'item'`: the item that was inserted will be selected
 *
 * @param {string} options.format - The format of the string `s`:
 *    * `'auto'`: the string is interpreted as a latex fragment or command)
 * (default)
 *    * `'latex'`: the string is interpreted strictly as a latex fragment
 *
 * @param {boolean} options.focus - If true, the mathfield will be focused after 
 * the insertion
 * 
 * @param {boolean} options.feedback - If true, provide audio and haptic feedback
 * 
 * @param {string} options.mode - 'text' or 'math'. If empty, the current mode
 * is used (default)
 * 
 * @method MathField#$insert
 */
MathField.prototype.insert_ =
MathField.prototype.insert = 
MathField.prototype.$insert = function(s, options) {
    if (typeof s === 'string' && s.length > 0) {
        options = options || {};
        if (options.focus) this.focus();
        if (options.feedback) {
            if (this.config.keypressVibration && navigator.vibrate) {
                navigator.vibrate(HAPTIC_FEEDBACK_DURATION);
            }
            if (this.keypressSound) {
                this.keypressSound.load();
                this.keypressSound.play();
            }
        }
        if (s === '\\\\') {
            // This string is interpreted as an "insert row after" command
            this.mathlist.addRowAfter_();
        } else if (s === '&') {
            this.mathlist.addColumnAfter_();
        } else {
            this.mathlist.insert(s, { mode: this.mode, ...options });
        }
        this.undoManager.snapshot(this.config);
        return true;
    }
    return false;
}


MathField.prototype.switchMode_ = function(mode, prefix, suffix) {
    this._resetKeystrokeBuffer();
    this.smartModeSuppressed = true;
    if (prefix) {
        this.insert(prefix, { 
            format: 'latex', 
            mode: {'math':'text', 'text':'math'}[mode]
        });
    }
    this.mode = mode;
    if (suffix) {
        this.insert(suffix, {             
            format: 'latex', 
            mode: mode
        });
    }
    // Notify of mode change
    if (typeof this.config.onModeChange === 'function') {
        this.config.onModeChange(this, this.mode)
    }
    this._render();
}


/**
 * When in command mode, insert the select command and return to math mode
 * If escape is true, the command is discared.
 * @param {boolean} escape if true, the command is discarded
 * @method MathField#complete_
 * @private
 */
MathField.prototype.complete_ = function(escape) {
    if (escape === undefined) escape = false;
    Popover.hidePopover(this);
    if (escape) {
        this.mathlist.spliceCommandStringAroundInsertionPoint(null);
        return true;
    }

    const command = this.mathlist.extractCommandStringAroundInsertionPoint();
    if (command) {
        if (command === '\\(' || command === '\\)') {
            this.mathlist.spliceCommandStringAroundInsertionPoint([]);
            this.mathlist.insert(command.slice(1), {mode: this.mode});
        } else {
            // We'll assume we want to insert in math mode
            // (commands are only available in math mode)
            const mode = 'math'

            if (Definitions.commandAllowed(mode, command)) {
                const mathlist = ParserModule.parseTokens(
                        Lexer.tokenize(command), mode, null, this.config.macros);

                this.mathlist.spliceCommandStringAroundInsertionPoint(mathlist);
            } else {
                // This wasn't a simple function or symbol.
                // Interpret the input as LaTeX code
                const mathlist = ParserModule.parseTokens(
                        Lexer.tokenize(command), mode, null, this.config.macros);
                if (mathlist) {
                    this.mathlist.spliceCommandStringAroundInsertionPoint(mathlist);
                } else {
                    this.mathlist.decorateCommandStringAroundInsertionPoint(true);
                }
            }
        }
        this.undoManager.snapshot(this.config);
        this._announce('replacement');
        return true;
    }
    return false;
}


MathField.prototype._updateSuggestion = function() {
    this.mathlist.positionInsertionPointAfterCommitedCommand();
    this.mathlist.removeSuggestion();
    const command = this.mathlist.extractCommandStringAroundInsertionPoint();
    const suggestions = Definitions.suggest(command);
    if (suggestions.length === 0) {
        Popover.hidePopover(this);
        this.mathlist.decorateCommandStringAroundInsertionPoint(true);
    } else {
        const index = this.suggestionIndex % suggestions.length;
        const l = command.length - suggestions[index].match.length;
        if (l !== 0) {
            this.mathlist.insertSuggestion(suggestions[index].match, l);
        }
        Popover.showPopoverWithLatex(this, suggestions[index].match, suggestions.length > 1);
    }

    this._render();
}

MathField.prototype.nextSuggestion_ = function() {
    this.suggestionIndex += 1;
    // The modulo of the suggestionIndex is used to determine which suggestion
    // to display, so no need to worry about rolling over.
    this._updateSuggestion();
    return false;
}

MathField.prototype.previousSuggestion_ = function() {
    this.suggestionIndex -= 1;
    if (this.suggestionIndex < 0) {
        // We're rolling over
        // Get the list of suggestions, so we can know how many there are
        // Not very efficient, but simple.
        this.mathlist.removeSuggestion();
        const command = this.mathlist.extractCommandStringAroundInsertionPoint();
        const suggestions = Definitions.suggest(command);
        this.suggestionIndex = suggestions.length - 1;
    }
    this._updateSuggestion();
    return false;
}



/**
 * Attach event handlers to an element so that it will react by executing
 * a command when pressed.
 * `'command'` can be:
 * - a string, a single selector
 * - an array, whose first element is a selector followed by one or more arguments.
 * - an object, with the following keys:
 *    * 'default': command performed on up, with a down + up sequence with no
 *      delay between down and up
 *    * 'alt', 'shift', 'altshift' keys: command performed on up with
 *      one of these modifiers pressed
 *    * 'pressed': command performed on 'down'
 *    * 'pressAndHoldStart': command performed after a tap/down followed by a
 * delay (optional)
 *    * 'pressAndHoldEnd': command performed on up, if there was a delay
 *     between down and up, if absent, 'default' is performed
 * The value of the keys specify which selector (string
 * or array) to perform depending on the keyboard state when the button is
 * pressed.
 *
 * The 'pressed' and 'active' classes will get added to
 * the element, as the :hover and :active pseudo-classes are not reliable
 * (at least on Chrome Android).
 *
 * @param {Element} el
 * @param {object|string} command
 */
MathField.prototype._attachButtonHandlers = function(el, command) {
    const that = this;

    if (typeof command === 'object' && (command.default || command.pressed)) {
        // Attach the default (no modifiers pressed) command to the element
        if (command.default) {
            el.setAttribute('data-' + this.config.namespace + 'command',
                JSON.stringify(command.default));
        }
        if (command.alt) {
            el.setAttribute('data-' + this.config.namespace + 'command-alt',
                JSON.stringify(command.alt));
        }
        if (command.altshift) {
            el.setAttribute('data-' + this.config.namespace + 'command-altshift',
                JSON.stringify(command.altshift));
        }
        if (command.shift) {
            el.setAttribute('data-' + this.config.namespace + 'command-shift',
                JSON.stringify(command.shift));
        }
        // .pressed: command to perform when the button is pressed (i.e.
        // on mouse down/touch). Otherwise the command is performed when
        // the button is released
        if (command.pressed) {
            el.setAttribute('data-' + this.config.namespace + 'command-pressed',
                JSON.stringify(command.pressed));
        }
        if (command.pressAndHoldStart) {
            el.setAttribute('data-' + this.config.namespace + 'command-pressAndHoldStart',
                JSON.stringify(command.pressAndHoldStart));
        }
        if (command.pressAndHoldEnd) {
            el.setAttribute('data-' + this.config.namespace + 'command-pressAndHoldEnd',
                JSON.stringify(command.pressAndHoldEnd));
        }
    } else {
        // We need to turn the command into a string to attach it to the dataset
        // associated with the button (the command could be an array made of a
        // selector and one or more parameters)
        el.setAttribute('data-' + this.config.namespace + 'command',
            JSON.stringify(command));
    }


    let pressHoldStart;
    let pressHoldElement;
    let touchID;
    let syntheticTarget;    // Target while touch move
    let pressAndHoldTimer;

    on(el, 'mousedown touchstart:passive', function(ev) {
        if (ev.type !== 'mousedown' || ev.buttons === 1) {
            // The primary button was pressed or the screen was tapped.
            ev.stopPropagation();

            el.classList.add('pressed');
            pressHoldStart = Date.now();

            // Record the ID of the primary touch point for tracking on touchmove
            if (ev.type === 'touchstart') touchID = ev.changedTouches[0].identifier;

            // Parse the JSON to get the command (and its optional arguments)
            // and perform it immediately
            const command = el.getAttribute('data-' + that.config.namespace + 'command-pressed');
            if (command) {
                that.perform(JSON.parse(command));
            }

            // If there is a `press and hold start` command, perform it
            // after a delay, if we're still pressed by then.
            const pressAndHoldStartCommand = el.getAttribute('data-' + that.config.namespace + 'command-pressAndHoldStart');
            if (pressAndHoldStartCommand) {
                pressHoldElement = el;
                if (pressAndHoldTimer) clearTimeout(pressAndHoldTimer);
                pressAndHoldTimer = window.setTimeout(function() {
                    if (el.classList.contains('pressed')) {
                        that.perform(JSON.parse(pressAndHoldStartCommand));
                    }
                }, 300);
            }

        }
    });
    on (el, 'mouseleave touchcancel', function() {
        el.classList.remove('pressed');
        // let command = el.getAttribute('data-' + that.config.namespace +
        //     'command-pressAndHoldEnd');
        // const now = Date.now();
        // if (command && now > pressHoldStart + 300) {
        //     that.perform(JSON.parse(command));
        // }
    });
    on (el, 'touchmove:passive', function(ev) {
        // Unlike with mouse tracking, touch tracking only sends events
        // to the target that was originally tapped on. For consistency,
        // we want to mimic the behavior of the mouse interaction by
        // tracking the touch events and dispatching them to potential targets
        ev.preventDefault();
        for (let i = 0; i < ev.changedTouches.length; i++) {
            if (ev.changedTouches[i].identifier === touchID) {
                // Found a touch matching our primary/tracked touch
                const target = document.elementFromPoint(
                        ev.changedTouches[i].clientX,
                        ev.changedTouches[i].clientY);
                if (target !== syntheticTarget && syntheticTarget) {
                    syntheticTarget.dispatchEvent(
                        new MouseEvent('mouseleave'), {bubbles: true});
                    syntheticTarget = null;
                }
                if (target) {
                    syntheticTarget = target;
                    target.dispatchEvent(new MouseEvent('mouseenter',
                        {bubbles: true, buttons: 1}));
                }
            }
        }
    });
    on (el, 'mouseenter', function(ev) {
        if (ev.buttons === 1) {
            el.classList.add('pressed');
        }
    });

    on(el, 'mouseup touchend click', function(ev) {
        if (syntheticTarget) {
            ev.stopPropagation();
            ev.preventDefault();
            const target = syntheticTarget;
            syntheticTarget = null;
            target.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
            return;
        }
        el.classList.remove('pressed');
        el.classList.add('active');
        if (ev.type === 'click' && ev.detail !== 0) {
            // This is a click event triggered by a mouse interaction
            // (and not a keyboard interaction)
            // Ignore it, we'll handle the mouseup (or touchend) instead.
            ev.stopPropagation();
            ev.preventDefault();
            return;
        }

        // Since we want the active state to be visible for a while,
        // use a timer to remove it after a short delay
        window.setTimeout(function(){ el.classList.remove('active'); }, 150);

        let command = el.getAttribute('data-' + that.config.namespace +
            'command-pressAndHoldEnd');
        const now = Date.now();
        // If the button has not been pressed for very long or if we were
        // not the button that started the press and hold, don't consider
        // it a press-and-hold.
        if (el !== pressHoldElement || now < pressHoldStart + 300) {
            command = undefined;
        }
        if (!command && ev.altKey && ev.shiftKey) {
            command = el.getAttribute('data-' + that.config.namespace +
                'command-altshift');
        }
        if (!command && ev.altKey) {
            command = el.getAttribute('data-' + that.config.namespace +
                'command-alt');
        }
        if (!command && ev.shiftKey) {
            command = el.getAttribute('data-' + that.config.namespace +
                'command-shift');
        }
        if (!command) {
            command = el.getAttribute('data-' + that.config.namespace +
                'command');
        }
        if (command) {
            // Parse the JSON to get the command (and its optional arguments)
            // and perform it
            that.perform(JSON.parse(command));
        }
        ev.stopPropagation();
        ev.preventDefault();
    });
}

MathField.prototype._makeButton = function(label, cls, ariaLabel, command) {
    const button = document.createElement('span');
    button.innerHTML = label;

    if (cls) button.classList.add([].slice.call(cls.split(' ')));

    if (ariaLabel) button.setAttribute('aria-label', ariaLabel);

    this._attachButtonHandlers(button, command);

    return button;
}


/**
 * Alternate options are displayed when a key on the virtual keyboard is pressed
 * and held.
 *
 */
MathField.prototype.showAlternateKeys_ = function(keycap, altKeys) {
    const altContainer = getSharedElement('mathlive-alternate-keys-panel', 'ML__keyboard alternate-keys');
    if (this.virtualKeyboard.classList.contains('material')) {
        altContainer.classList.add('material');
    }

    if (altKeys.length >= 7) {
        // Width 4
        altContainer.style.width = '286px';
    } else if (altKeys.length === 4 || altKeys.length === 2) {
        // Width 2
        altContainer.style.width = '146px';
    } else if (altKeys.length === 1) {
        // Width 1
        altContainer.style.width = '86px';
    } else {
        // Width 3
        altContainer.style.width = '146px';
    }
    // Reset container height
    altContainer.style.height = 'auto';


    let markup = '';
    for (const altKey of altKeys) {
        markup += '<li';
        if (typeof altKey === 'string') {
            markup += ' data-latex="' + altKey.replace(/"/g, '&quot;') + '"';
        } else {
            if (altKey.latex) {
                markup += ' data-latex="' + altKey.latex.replace(/"/g, '&quot;') + '"';
            }
            if (altKey.content) {
                markup += ' data-content="' + altKey.content.replace(/"/g, '&quot;') + '"';
            }
            if (altKey.insert) {
                markup += ' data-insert="' + altKey.insert.replace(/"/g, '&quot;') + '"';
            }
            if (altKey.command) {
                markup += " data-command='" + altKey.command.replace(/"/g, '&quot;') + "'";
            }
            if (altKey.aside) {
                markup += ' data-aside="' + altKey.aside.replace(/"/g, '&quot;') + '"';
            }
            if (altKey.classes) {
                markup += ' data-classes="' + altKey.classes + '"';
            }
        }

        markup += '>';
        markup += altKey.label || '';

        markup += '</li>';
    }
    markup = '<ul>' + markup + '</ul>';

    altContainer.innerHTML = markup;

    VirtualKeyboard.makeKeycap(this,
        altContainer.getElementsByTagName('li'), 'performAlternateKeys');

    const keycapEl = this.virtualKeyboard.querySelector(
        'div.keyboard-layer.is-visible div.rows ul li[data-alt-keys="' + keycap + '"]');
    const position = keycapEl.getBoundingClientRect();
    if (position) {
        if (position.top - altContainer.clientHeight < 0) {
            // altContainer.style.maxWidth = '320px';  // Up to six columns
            altContainer.style.width = 'auto';
            if (altKeys.length <= 6) {
                altContainer.style.height = '56px';     // 1 row
            } else if (altKeys.length <= 12) {
                altContainer.style.height = '108px';    // 2 rows
            } else {
                altContainer.style.height = '205px';    // 3 rows
            }
        }
        const top = (position.top - altContainer.clientHeight + 5).toString() + 'px';
        const left = Math.max(0,
            Math.min(window.innerWidth - altContainer.offsetWidth,
            ((position.left + position.right - altContainer.offsetWidth) / 2) )) + 'px';
        altContainer.style.transform = 'translate(' + left + ',' + top + ')'
        altContainer.classList.add('is-visible');
    }
    return false;
}


MathField.prototype.hideAlternateKeys_ = function() {
    const altContainer = document.getElementById('mathlive-alternate-keys-panel');
    if (altContainer) {
        altContainer.classList.remove('is-visible');
        altContainer.innerHTML = '';
        delete releaseSharedElement(altContainer);
    }
    return false;
}

/**
 * The command invoked when an alternate key is pressed.
 * We need to hide the Alternate Keys panel, then perform the
 * command.
 */
MathField.prototype.performAlternateKeys_ = function(command) {
    this.hideAlternateKeys_();
    return this.perform(command);
}


MathField.prototype.switchKeyboardLayer_ = function(layer) {
    if (this.config.virtualKeyboardMode !== 'off') {

        if (layer !== 'lower-command' && layer !== 'upper-command' && layer !== 'symbols-command') {
            // If we switch to a non-command keyboard layer, first exit command mode.
            this.complete_();
        }

        this.showVirtualKeyboard_();

        // If the alternate keys panel was visible, hide it
        this.hideAlternateKeys_();

        // If we were in a temporarily shifted state (shift-key held down)
        // restore our state before switching to a new layer.
        this.unshiftKeyboardLayer_();

        const layers = this.virtualKeyboard.getElementsByClassName('keyboard-layer');
        // Search for the requested layer
        let found = false;
        for (let i = 0; i < layers.length; i++) {
            if (layers[i].id === layer) {
                found = true;
                break;
            }
        }

        // We did find the layer, switch to it.
        // If we didn't find it, do nothing and keep the current layer
        if (found) {
            for (let i = 0; i < layers.length; i++) {
                if (layers[i].id === layer) {
                    layers[i].classList.add('is-visible');
                } else {
                    layers[i].classList.remove('is-visible');
                }
            }
        }

        this.focus();
    }
    return true;
}


/**
 * Temporarily change the labels and the command of the keys
 * (for example when a modifier key is held down.)
 */
MathField.prototype.shiftKeyboardLayer_ = function() {
    const keycaps = this.virtualKeyboard.querySelectorAll(
        'div.keyboard-layer.is-visible .rows .keycap, div.keyboard-layer.is-visible .rows .action');
    if (keycaps) {
        for (let i = 0; i < keycaps.length; i++) {
            const keycap = keycaps[i];
            let shiftedContent = keycap.getAttribute('data-shifted');
            if (shiftedContent || /^[a-z]$/.test(keycap.innerHTML)) {
                keycap.setAttribute('data-unshifted-content', keycap.innerHTML);

                if (!shiftedContent) {
                    shiftedContent = keycap.innerHTML.toUpperCase();
                }
                keycap.innerHTML = shiftedContent;

                const command = keycap.getAttribute('data-' + this.config.namespace + 'command');
                if (command) {
                    keycap.setAttribute('data-unshifted-command', command);
                    const shiftedCommand = keycap.getAttribute('data-shifted-command');
                    if (shiftedCommand) {
                        keycap.setAttribute('data-' + this.config.namespace + 'command',
                            shiftedCommand);
                    } else {
                        const commandObj = JSON.parse(command);
                        if (Array.isArray(commandObj)) {
                            commandObj[1] = commandObj[1].toUpperCase()
                        }
                        keycap.setAttribute('data-' + this.config.namespace + 'command',
                            JSON.stringify(commandObj));
                    }
                }

            }
        }
    }
    return false;
}



/**
 * Restore the key labels and commands to the state before a modifier key
 * was pressed.
 *
 */
MathField.prototype.unshiftKeyboardLayer_ = function() {
    const keycaps = this.virtualKeyboard.querySelectorAll(
        'div.keyboard-layer.is-visible .rows .keycap, div.keyboard-layer.is-visible .rows .action');
    if (keycaps) {
        for (let i = 0; i < keycaps.length; i++) {
            const keycap = keycaps[i];
            const content = keycap.getAttribute('data-unshifted-content');
            if (content) {
                keycap.innerHTML = content;
            }
            const command = keycap.getAttribute('data-unshifted-command');
            if (command) {
                keycap.setAttribute('data-' + this.config.namespace + 'command',
                    command);
            }
        }
    }
    return false;
}

MathField.prototype.insertAndUnshiftKeyboardLayer_ = function(c) {
    this.insert_(c);
    this.unshiftKeyboardLayer_();
    return true;
}

/* Toggle the virtual keyboard, but switch to the alternate theme if available */
MathField.prototype.toggleVirtualKeyboardAlt_ = function() {
    let hadAltTheme = false;
    if (this.virtualKeyboard) {
        hadAltTheme = this.virtualKeyboard.classList.contains('material');
        this.virtualKeyboard.remove();
        delete this.virtualKeyboard;
        this.virtualKeyboard = null;
    }
    this.showVirtualKeyboard_(hadAltTheme ? '' : 'material');
    return false;
}

/* Toggle the virtual keyboard, but switch another keyboard layout */
MathField.prototype.toggleVirtualKeyboardShift_ = function() {
    this.config.virtualKeyboardLayout = {
        'qwerty': 'azerty',
        'azerty': 'qwertz',
        'qwertz': 'dvorak',
        'dvorak': 'colemak',
        'colemak': 'qwerty'
    }[this.config.virtualKeyboardLayout];

    let layer = this.virtualKeyboard ?
        this.virtualKeyboard.querySelector('div.keyboard-layer.is-visible') : null;
    layer = layer ? layer.id : '';

    if (this.virtualKeyboard) {
        this.virtualKeyboard.remove();
        delete this.virtualKeyboard;
        this.virtualKeyboard = null;
    }
    this.showVirtualKeyboard_();
    if (layer) this.switchKeyboardLayer_(layer);
    return false;
}

MathField.prototype.showVirtualKeyboard_ = function(theme) {
    this.virtualKeyboardVisible = false;
    this.toggleVirtualKeyboard_(theme);
    return false;
}

MathField.prototype.hideVirtualKeyboard_ = function() {
    this.virtualKeyboardVisible = true;
    this.toggleVirtualKeyboard_();
    return false;
}

MathField.prototype.toggleVirtualKeyboard_ = function(theme) {
    this.virtualKeyboardVisible = !this.virtualKeyboardVisible;
    if (this.virtualKeyboardVisible) {
        if (this.virtualKeyboard) {
            this.virtualKeyboard.classList.add('is-visible');
        } else {
            // Construct the virtual keyboard
            this.virtualKeyboard = VirtualKeyboard.make(this, theme);

            // Let's make sure that tapping on the keyboard focuses the field
            on(this.virtualKeyboard, 'touchstart:passive mousedown', function() {
                that.focus();
            });
            document.body.appendChild(this.virtualKeyboard);
        }
        // For the transition effect to work, the property has to be changed
        // after the insertion in the DOM. Use setTimeout
        const that = this;
        window.setTimeout(function() { that.virtualKeyboard.classList.add('is-visible'); }, 1);
    } else if (this.virtualKeyboard) {
        this.virtualKeyboard.classList.remove('is-visible');
    }

    if (typeof this.config.onVirtualKeyboardToggle === 'function') {
        this.config.onVirtualKeyboardToggle(
            this,
            this.virtualKeyboardVisible, 
            this.virtualKeyboard);
    }
    return false;
}

MathField.prototype.applyStyle_ = function(style) {
    this._resetKeystrokeBuffer();
    if (style.mode) {
        // It's a mode ('text', 'math') change
        if (this.mathlist.isCollapsed()) {
            // Nothing selected, simply toggle the mode that 
            // will be applied to the next insertion
            this.switchMode_(this.mode === 'math' ? 'text' : 'math');

        } else {
            // Convert the selection from one mode to another
            const previousMode = this.mode;
            const targetMode = 
                (this.mathlist.anchorMode() || this.config.default) === 'math' ?
                    'text' : 'math';
            let convertedSelection = this.$selectedText('ASCIIMath');
            if (targetMode === 'math' && /^"[^"]+"$/.test(convertedSelection)) {
                convertedSelection = convertedSelection.slice(1, -1);
            }
            this.insert(convertedSelection, {
                mode: targetMode,
                selectionMode: 'item',
                format: targetMode === 'text' ? 'text' : 'ASCIIMath'
            });

            this.mode = targetMode;

            if (this.groupIsSelected()) {
                // The entire group was selected. Adjust parent mode if 
                // appropriate
                const parent = this.mathlist.parent();
                if (parent && (parent.type === 'group' || parent.type === 'root')) {
                    parent.mode = targetMode;
                }
            }

            // Notify of mode change
            if (this.mode !== previousMode && typeof this.config.onModeChange === 'function') {
                this.config.onModeChange(this, this.mode)
            }

        }
    } else {
        this.mathlist._applyStyle(style);
        this.undoManager.snapshot(this.config);
    }
    return true;
}

MathField.prototype.hasFocus = 
MathField.prototype.$hasFocus = function() {
    return document.hasFocus() && document.activeElement === this.textarea;
}

MathField.prototype.focus = 
MathField.prototype.$focus = function() {
    if (!this.hasFocus()) {
        // The textarea may be a span (on mobile, for example), so check that
        // it has a focus() before calling it.
        if (this.textarea.focus) this.textarea.focus();
        this._announce('line');
    }
}

MathField.prototype.blur = 
MathField.prototype.$blur = function() {
    if (this.hasFocus()) {
        if (this.textarea.blur) {
            this.textarea.blur();
        }
    }
}

MathField.prototype.select = 
MathField.prototype.$select = function() {
    this.mathlist.selectAll_();
}

MathField.prototype.clearSelection = 
MathField.prototype.$clearSelection = function() {
    this.mathlist.delete_();
}


/**
 * @param {string} keys - A string representation of a key combination. 
 * 
 * For example `'Alt-KeyU'`.
 * 
 * See [W3C UIEvents](https://www.w3.org/TR/uievents/#code-virtual-keyboards)
 * @param {Event} evt
 * @return {boolean} 
 * @method MathField#$keystroke
 */
MathField.prototype.keystroke = 
MathField.prototype.$keystroke = function(keys, evt) {
    // This is the public API, while onKeystroke is the
    // internal handler
    return this._onKeystroke(keys, evt);
}


/**
 * Simulate a user typing the keys indicated by text.
 * @param {string} text - A sequence of one or more characters.
 * @method MathField#$typedText
 */
MathField.prototype.typedText = 
MathField.prototype.$typedText = function(text) {
    // This is the public API, while onTypedText is the
    // internal handler
    this._onTypedText(text);
}


/**
 *
 * @param {string} text
 * @param {Object.<string, any>} [options={}]
 * @param {boolean} options.focus - If true, the mathfield will be focused
 * @param {boolean} options.feedback - If true, provide audio and haptic feedback
 * @param {boolean} options.simulateKeystroke - If true, generate some synthetic
 * keystrokes (useful to trigger inline shortcuts, for example)
 */
MathField.prototype.typedText_ = function(text, options) {
    return this._onTypedText(text, options);
}


/**
 * 
 * Update the configuration options for this mathfield.
 * 
 * @param {Object<string, any>} [config={}] See {@tutorial CONFIG} for details.
 * 
 * @method MathField#$setConfig
 */
MathField.prototype.setConfig = 
MathField.prototype.$setConfig = function(conf) {
    if (!this.config) {
        this.config = {
            smartFence: true,
            smartSuperscript: true,
            scriptDepth: [Infinity, Infinity],
            removeExtraneousParentheses: true,
            overrideDefaultInlineShortcuts: false,
            virtualKeyboard: '',
            virtualKeyboardLayout: 'qwerty',
            namespace: '',
        }
    }
    this.config = {...this.config, ...conf};
    if (!Array.isArray(this.config.scriptDepth)) {
        const depth = parseInt(this.config.scriptDepth);
        this.config.scriptDepth = [depth, depth];
    }

    if (typeof this.config.removeExtraneousParentheses === 'undefined') {
        this.config.removeExtraneousParentheses = true;
    }

    this.config.onAnnounce = conf.onAnnounce || _onAnnounce;

    this.config.macros = Object.assign({}, Definitions.MACROS, this.config.macros);

    // Validate the namespace (used for `data-` attributes)
    if (!/^[a-z]*[-]?$/.test(this.config.namespace)) {
        throw Error('options.namespace must be a string of lowercase characters only');
    }
    if (!/-$/.test(this.config.namespace)) {
        this.config.namespace += '-';
    }

    // Localization strings override (or localizations for new locales)
    l10n.locale = this.config.locale || l10n.locale;
    l10n.merge(this.config.strings);

    // Possible keypress sound feedback
    this.keypressSound = undefined;
    this.spacebarKeypressSound = undefined;
    this.returnKeypressSound = undefined;
    this.deleteKeypressSound = undefined;
    if (this.config.keypressSound) {
        if (typeof this.config.keypressSound === 'string') {
            this.keypressSound = new Audio();
            this.keypressSound.preload = 'none';
            this.keypressSound.src = this.config.keypressSound;
            this.keypressSound.volume = AUDIO_FEEDBACK_VOLUME;
            this.spacebarKeypressSound = this.keypressSound;
            this.returnKeypressSound = this.keypressSound;
            this.deleteKeypressSound = this.keypressSound;
        } else {
            console.assert(this.config.keypressSound.default);
            this.keypressSound = new Audio();
            this.keypressSound.preload = 'none';
            this.keypressSound.src = this.config.keypressSound.default;
            this.keypressSound.volume = AUDIO_FEEDBACK_VOLUME;
            this.spacebarKeypressSound = this.keypressSound;
            this.returnKeypressSound = this.keypressSound;
            this.deleteKeypressSound = this.keypressSound;
            if (this.config.keypressSound.spacebar) {
                this.spacebarKeypressSound = new Audio();
                this.spacebarKeypressSound.preload = 'none';
                this.spacebarKeypressSound.src = this.config.keypressSound.spacebar;
                this.spacebarKeypressSound.volume = AUDIO_FEEDBACK_VOLUME;
            }
            if (this.config.keypressSound.return) {
                this.returnKeypressSound = new Audio();
                this.returnKeypressSound.preload = 'none';
                this.returnKeypressSound.src = this.config.keypressSound.return;
                this.returnKeypressSound.volume = AUDIO_FEEDBACK_VOLUME;
            }
            if (this.config.keypressSound.delete) {
                this.deleteKeypressSound = new Audio();
                this.deleteKeypressSound.preload = 'none';
                this.deleteKeypressSound.src = this.config.keypressSound.delete;
                this.deleteKeypressSound.volume = AUDIO_FEEDBACK_VOLUME;
            }
        }
    }

    if (this.config.plonkSound) {
        this.plonkSound = new Audio();
        this.plonkSound.preload = 'none';
        this.plonkSound.src = this.config.plonkSound;
        this.plonkSound.volume = AUDIO_FEEDBACK_VOLUME;
    }
}




MathField.prototype._speakWithSynchronizedHighlighting = function(text) {
    if (!this.config.handleReadAloud) return;
    this.config.handleReadAloud(this.field, text, this.config);
}


MathField.prototype._speak = function(text) {
    if (!this.config.handleSpeak) return;
    this.config.handleSpeak(text, this.config);
}

/**
 * @method MathField#speakSelection_
 */
MathField.prototype.speakSelection_ = function() {
    let text = "Nothing selected.";
    if (!this.mathlist.isCollapsed()) {
        text = MathAtom.toSpeakableText(this.mathlist.getSelectedAtoms(), this.config)
    }
    this._speak(text);
    return false;
}

/**
 * @method MathField#speakSelectionWithSynchronizedHighlighting_
 */
MathField.prototype.speakSelectionWithSynchronizedHighlighting_ = function() {
    if (!this.mathlist.isCollapsed()) {
        window.mathlive.readAloudMathField = this;
        this._render({forHighlighting: true});
        const options = this.config;
        options.textToSpeechMarkup = (window.sre && options.textToSpeechRules === 'sre') ? 'ssml_step' : 'ssml';
        const text = MathAtom.toSpeakableText(this.mathlist.getSelectedAtoms(), options)
        this._speakWithSynchronizedHighlighting(text);
    } else {
        this._speak("Nothing selected.");
    }
    return false;
}


/**
 * @method MathField#speakParent_
 */
MathField.prototype.speakParent_ = function() {
    let text = 'No parent.';
    const parent = this.mathlist.parent();
    if (parent && parent.type !== 'root') {
        text = MathAtom.toSpeakableText(this.mathlist.parent(), this.config);
    }
    this._speak(text);
    return false;
}

/**
 * @method MathField#speakRightSibling_
 */
MathField.prototype.speakRightSibling_ = function() {
    let text = 'At the end.';
    const siblings = this.mathlist.siblings();
    const first = this.mathlist.startOffset() + 1;
    if (first < siblings.length - 1) {
        const adjSiblings = [];
        for (let i = first; i <= siblings.length - 1; i++) {
            adjSiblings.push(siblings[i]);
        }
        text = MathAtom.toSpeakableText(adjSiblings, this.config);
    }
    this._speak(text);
    return false;
}

/**
 * @method MathField#speakLeftSibling_
 */
MathField.prototype.speakLeftSibling_ = function() {
    let text = 'At the beginning.';
    const siblings = this.mathlist.siblings();
    const last = this.mathlist.isCollapsed() ? this.mathlist.startOffset() : this.mathlist.startOffset() - 1;
    if (last >= 1) {
        const adjSiblings = [];
        for (let i = 1; i <= last; i++) {
            adjSiblings.push(siblings[i]);
        }
        text = MathAtom.toSpeakableText(adjSiblings, this.config);
    }
    this._speak(text);
    return false;
}


/**
 * @method MathField#speakGroup_
 */
MathField.prototype.speakGroup_ = function() {
    this._speak(MathAtom.toSpeakableText(this.mathlist.siblings(), this.config));
    return false;
}

/**
 * @method MathField#speakAll_
 */
MathField.prototype.speakAll_ = function() {
    this._speak(MathAtom.toSpeakableText(this.mathlist.root, this.config));
    return false;
}

/**
 * @method MathField#speakAllWithSynchronizedHighlighting_
 */
MathField.prototype.speakAllWithSynchronizedHighlighting_ = function() {
    window.mathlive.readAloudMathField = this;
    this._render({forHighlighting: true});
    const options = this.config;
    options.textToSpeechMarkup = (window.sre && options.textToSpeechRules === 'sre') ? 'ssml_step' : 'ssml';
    const text = MathAtom.toSpeakableText(this.mathlist.root, options)
    this._speakWithSynchronizedHighlighting(text);
    return false;
}




export default {
    MathField: MathField
}





