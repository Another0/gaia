/**
  Copyright 2012, Mozilla Foundation

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/
'use strict';

/**
 * XXX: Before we use real keyboard as input pad, we need this to
 * control the custom input pad. See Bug 1053680.
 **/
(function(exports) {
  /**
   * We still need the interface to notify the LockScreen.
   *
   * @param LockScreenFaçade
   **/
  var LockScreenInputpad = function(lockScreen) {
    this.lockScreen = lockScreen;
    this.configs = {
      padVibrationDuration: 50
    };
    this.states = {
      // Keep in sync with Dialer and Keyboard vibration
      padVibrationEnabled: false,
      passCodeEntered: '',
      passCodeErrorTimeoutPending: false
    };
  };
  LockScreenInputpad.prototype.start = function() {
    this.addEventListener('lockscreen-notify-passcode-validationfailed');
    this.addEventListener('lockscreen-notify-passcode-validationreset');
    this.addEventListener('lockscreen-notify-passcode-validationsuccess');
    this.addEventListener('lockscreen-inputappclosed', this);
    this.addEventListener('lockscreen-inputappopened', this);

    this.passcodeCode = document.getElementById('lockscreen-passcode-code');
    this.passcodePad = document.getElementById('lockscreen-passcode-pad');
    this.emergencyCallBtn = this.passcodePad.querySelector('a[data-key=e]');

    /* lastTouchedKey
     * Keeps track of the key that was under the finger during
     * the previous 'touchmove' event. UI must be redrawn only if
     * the finger moved to a different key.
     */
    this.lastTouchedKey = null;

    this.passcodePad.addEventListener('click', this);
    this.passcodePad.addEventListener('touchstart', this);
    this.passcodePad.addEventListener('touchmove', this);
    this.passcodePad.addEventListener('touchend', this);

    window.SettingsListener.observe('keyboard.vibration',
      false, (function(value) {
      this.states.padVibrationEnabled = !!value;
    }).bind(this));

    this.renderUI();
    return this;
  };

  /**
   * Rendering the whole UI, including waiting all necessary conditions.
   * So rendering functions all should be Promised.
   */
  LockScreenInputpad.prototype.renderUI = function() {
    return new Promise((resolve, reject) => {
      this.toggleEmergencyButton();
      this.updatePassCodeUI();
      resolve();
    });
  };

  LockScreenInputpad.prototype.toggleEmergencyButton = function() {
    if ('undefined' === typeof navigator.mozTelephony ||
        !navigator.mozTelephony) {
      this.disableEmergencyButton();
    } else {
      this.enableEmergencyButton();
    }
  };

  LockScreenInputpad.prototype.disableEmergencyButton = function() {
    this.emergencyCallBtn.classList.add('disabled');
  };

  LockScreenInputpad.prototype.enableEmergencyButton = function() {
    this.emergencyCallBtn.classList.remove('disabled');
  };

  LockScreenInputpad.prototype.handleEvent = function(evt) {
    var touch, target, key;
    switch (evt.type) {
      // The event flow from lockscreen.js is:
      // on pass code fail:
      //   - 'validationfailed' -> (validation timeout) -> 'validationreset'
      // on pass code success:
      //   - 'validationsuccess'
      case 'lockscreen-notify-passcode-validationfailed':
        this.states.passCodeErrorTimeoutPending = true;
        this.updatePassCodeUI();
        break;
      case 'lockscreen-notify-passcode-validationreset':
      case 'lockscreen-notify-passcode-validationsuccess':
        // Currently both validationreset and validationsuccess
        // just need to reset Inputpad's internal state.
        this.states.passCodeEntered = '';
        this.states.passCodeErrorTimeoutPending = false;
        this.updatePassCodeUI();
        break;
      case 'lockscreen-inputappopened':
      case 'lockscreen-inputappclosed':
        this.updatePassCodeUI();
        break;
      case 'touchstart':
        // Determine which key the finger is on from touch coordinates.
        // evt.target remains on where the touch started.
        touch = evt.changedTouches[0];
        target = document.elementFromPoint(touch.clientX, touch.clientY);
        key = this._keyForTarget(target);

        if (!key) {
          break;
        }
        if (this.lastTouchedKey) {
          this._makeKeyInactive(this.lastTouchedKey);
        }
        this._makeKeyActive(target);
        this.lastTouchedKey = target;
        if (this.states.padVibrationEnabled &&
          !this.states.passCodeErrorTimeoutPending) {
          navigator.vibrate(this.configs.padVibrationDuration);
        }
        break;
      case 'touchmove':
        // On touchmove, update keyboard display if and only if
        // finger moves between keys.

        // Determine which key the finger is on from touch coordinates.
        // evt.target remains on where the touch started.
        touch = evt.changedTouches[0];
        target = document.elementFromPoint(touch.clientX, touch.clientY);
        key = this._keyForTarget(target);

        // State update is only required if the touch location moved
        // onto a different key than in the last round.
        if (target.textContent !== this.lastTouchedKey.textContent) {
          if (this.lastTouchedKey) {
            // Make old key inactive
            this._makeKeyInactive(this.lastTouchedKey);
          }
          if (key) {
            // Make new key active
            this._makeKeyActive(target);
            // Remember new key for the next event
            this.lastTouchedKey = target;
          } else {
            // If there's no new key, touch moved beyond the keypad
            this.lastTouchedKey = null;
          }
        }
        break;
      case 'touchend':
        // On touchend, handle input from the key over which the
        // finger was released.

        evt.preventDefault();  // prevent the 'click'

        // Determine which key the finger is on from touch coordinates.
        // evt.target remains on where the touch started.
        touch = evt.changedTouches[0];
        target = document.elementFromPoint(touch.clientX, touch.clientY);
        key = this._keyForTarget(target);

        if (this.lastTouchedKey) {
          // Make old key inactive
          this._makeKeyInactive(this.lastTouchedKey);
          this.lastTouchedKey = null;
        }
        if (key) {
          // If touch ended on a key, handle key input
          this.handlePassCodeInput(key);
        }
        break;
      case 'click':
        // Handle the traditional click event. Only required on
        // platforms that don't support touch events.
        target = evt.target;
        key = this._keyForTarget(target);
        if (this.lastTouchedKey) {
          this._makeKeyInactive(this.lastTouchedKey);
          this.lastTouchedKey = null;
        }
        if (key) {
          // If click landed on a key, handle key input
          this.handlePassCodeInput(key);
        }
        break;
    }
  };

  LockScreenInputpad.prototype._anchorForTarget = function(target) {
    // Find ancestorial anchor that has info on the key
    // Current structure: a > div > span
    try {
      if (target.tagName !== 'A') {
        target = target.parentNode;
      }
      if (target.tagName !== 'A') {
        target = target.parentNode;
      }
      if (target.tagName === 'A') {
        return target;
      }
      return null;
    }
    catch (e) {
      return null;
    }
  };

  LockScreenInputpad.prototype._keyForTarget = function(target) {
    var anchor = this._anchorForTarget(target);
    if (anchor) {
      return anchor.dataset.key;
    } else {
      return null;
    }
  };

  LockScreenInputpad.prototype._makeKeyActive = function(target) {
    var anchor = this._anchorForTarget(target);
    if (anchor) {
      anchor.classList.add('active-key');
    } else {
      throw Error('lsip_makeKeyActive called with non-key node');
    }
  };

  LockScreenInputpad.prototype._makeKeyInactive = function(target) {
    var anchor = this._anchorForTarget(target);
    if (anchor) {
      anchor.classList.remove('active-key');
    } else {
      throw Error('lsip_makeKeyInactive called with non-key node');
    }
  };

  LockScreenInputpad.prototype.dispatchEvent = function(evt) {
    window.dispatchEvent(evt);
  };

  LockScreenInputpad.prototype.addEventListener = function(name, cb) {
    cb = cb || this;
    window.addEventListener(name, cb);
  };

  LockScreenInputpad.prototype.removeEventListener = function(name, cb) {
    cb = cb || this;
    window.removeEventListener(name, cb);
  };

  LockScreenInputpad.prototype.updatePassCodeUI =
  function() {
    if (this.states.passCodeEntered) {
      this.passcodePad.classList.add('passcode-entered');
    } else {
      this.passcodePad.classList.remove('passcode-entered');
    }
    if (this.states.passCodeEntered.length !== 4 &&
        this.passcodePad.classList.contains('passcode-fulfilled')) {
      this.passcodePad.classList.remove('passcode-fulfilled');
    }
    if (this.states.passCodeErrorTimeoutPending) {
      this.passcodeCode.classList.add('error');
    } else {
      this.passcodeCode.classList.remove('error');
    }
    var i = 4;
    while (i--) {
      var span = this.passcodeCode.childNodes[i];
      if (span) {
        if (this.states.passCodeEntered.length > i) {
          span.dataset.dot = true;
        } else {
          delete span.dataset.dot;
        }
      }
    }
  };

  LockScreenInputpad.prototype.handlePassCodeInput =
  function(key) {
    switch (key) {
      case 'e': // 'E'mergency Call
        // Cancel the notification clicked to activate.
        if (this.lockScreen._unlockingMessage.notificationId) {
          delete this.lockScreen._unlockingMessage.notificationId;
        }
        this.lockScreen.invokeSecureApp('emergency-call');
        break;

      case 'c': // 'C'ancel
        // Cancel the notification clicked to activate.
        if (this.lockScreen._unlockingMessage.notificationId) {
          delete this.lockScreen._unlockingMessage.notificationId;
        }
        this.dispatchEvent(new window.CustomEvent(
          'lockscreen-keypad-input', { detail: {
            key: key
          }
        }));
        break;

      case 'b': // 'B'ackspace for correction
        if (this.states.passCodeErrorTimeoutPending) {
          break;
        }
        this.states.passCodeEntered =
          this.states.passCodeEntered.substr(0,
            this.states.passCodeEntered.length - 1);
        this.updatePassCodeUI();
        break;

      default:
        if (this.states.passCodeErrorTimeoutPending) {
          break;
        }
        // If it's already 4 digits and this is the > 5th one,
        // don't do anything.
        if (this.states.passCodeEntered.length === 4) {
          return;
        }

        this.states.passCodeEntered += key;
        this.updatePassCodeUI();

        if (this.states.passCodeEntered.length === 4) {
          this.passcodePad.classList.add('passcode-fulfilled');
          this.lockScreen.checkPassCode(this.states.passCodeEntered);
        }
        break;
    }
  };

  exports.LockScreenInputpad = LockScreenInputpad;
})(window);

