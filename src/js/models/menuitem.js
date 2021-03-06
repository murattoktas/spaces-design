/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

define(function (require, exports, module) {
    "use strict";

    var os = require("adapter").os,
        _ = require("lodash"),
        Immutable = require("immutable");

    var UI = require("adapter").ps.ui;

    var MenuShortcut = require("./menushortcut"),
        object = require("js/util/object"),
        nls = require("js/util/nls"),
        keyutil = require("js/util/key");

    /**
     * A model of a menu item
     *
     * @constructor
     */
    var MenuItem = Immutable.Record({
        /**
         * "separator" for separators, unused otherwise
         * @type {string} 
         */
        type: null,

        /**
         * ID of the menu item, building up from Root
         * @type {string} 
         */
        id: null,

        /**
         * In-place identifier of menu item
         * @type {string} 
         */
        itemID: null,

        /**
         *  Localized label to show for this item
         * @type {string}
         */
        label: null,

        /**
         * @type {Immutable.List.<MenuItem>}
         */
        submenu: null,

        /**
         * @type {string}
         */
        command: null,

        /**
         * @type {string}
         */
        commandKind: null,

        /**
         * @type {?MenuShortcut}
         */
        shortcut: null,

        /**
         * @type {boolean}
         */
        enabled: true,

        /**
         * @type {boolean}
         */
        checked: false
    });

    Object.defineProperties(MenuItem.prototype, object.cachedGetSpecs({
        /**
         * Maps from submenu itemID to index, excluding separators.
         * @type {Immutable.Map.<string, number>}
         */
        submenuMap: function () {
            var submenu = this.submenu;
            if (!submenu) {
                return null;
            }

            return Immutable.Map(submenu.reduce(function (map, entry, index) {
                if (entry.type === "separator") {
                    return map;
                } else {
                    return map.set(entry.itemID, index);
                }
            }, new Map()));
        }
    }));

    /**
     * Get a sub-menu item by its ID.
     *
     * @param {string} menuID
     * @return {?MenuItem}
     */
    MenuItem.prototype.byID = function (menuID) {
        var index = this.submenuMap.get(menuID, -1);

        if (index < 0) {
            return null;
        }

        return this.submenu.get(index);
    };

    /**
     * Get a localized label for the given menu entry ID
     * Helper to nls.localize, prepending "menu." to the menu item ID
     *
     * @private
     * @param {string} id
     * @return {string|Object.<string, string>}
     */
    var _getLabelForEntry = function (id) {
        return nls.localize("menu." + id);
    };

    /**
     * Get a localized label for the given submenu ID
     *
     * @private
     * @param {string} id
     * @return {string}
     */
    var _getLabelForSubmenu = function (id) {
        var labels = _getLabelForEntry(id);

        if (!labels.hasOwnProperty("$MENU")) {
            throw new Error("Missing label for menu: " + id);
        }

        return labels.$MENU;
    };

    /**
     * Process a high-level menu description into a low-level menu description
     * that can be submitted to the adapter for installation. Ensures that each
     * menu item has the correct command ID and localized label.
     *
     * @param {object} rawMenu
     * @param {string=} prefix
     * @param {Object.<string, Object.<number, boolean>>} shortcutTable Existence check for shortcuts
     * @return {MenuItem}
     */
    MenuItem.fromDescriptor = function (rawMenu, prefix, shortcutTable) {
        if (shortcutTable === undefined) {
            shortcutTable = {};
        }

        var processedMenu = {};

        if (rawMenu.separator) {
            processedMenu.type = "separator";
            return new MenuItem(processedMenu);
        }

        if (!rawMenu.hasOwnProperty("id")) {
            throw new Error("Missing menu id");
        }
        processedMenu.id = rawMenu.id;

        var id;
        if (prefix === undefined) {
            id = rawMenu.id;
        } else {
            id = prefix + "." + rawMenu.id;
        }

        processedMenu.id = id;
        processedMenu.itemID = rawMenu.id;

        if (rawMenu.hasOwnProperty("enabled")) {
            processedMenu.enabled = rawMenu.enabled;
        }

        if (rawMenu.hasOwnProperty("submenu")) {
            processedMenu.label = _getLabelForSubmenu(id);

            var rawSubMenu = rawMenu.submenu;

            // Filter out debug-only menu entries in non-debug mode
            if (!__PG_DEBUG__) {
                rawSubMenu = rawSubMenu.filter(function (subMenu) {
                    return !subMenu.debug;
                });
            }

            rawSubMenu = rawSubMenu.map(function (rawSubMenu) {
                return MenuItem.fromDescriptor(rawSubMenu, id, shortcutTable);
            }, this);

            processedMenu.submenu = Immutable.List(rawSubMenu);
        } else {
            processedMenu.label = _getLabelForEntry(id);
            processedMenu.command = id;
        }

        if (rawMenu.hasOwnProperty("commandKind")) {
            processedMenu.commandKind = UI.commandKind[rawMenu.commandKind];
        }
        
        if (rawMenu.hasOwnProperty("shortcut")) {
            var rawKeyChar = rawMenu.shortcut.keyChar,
                rawKeyCode = rawMenu.shortcut.keyCode,
                rawModifiers = rawMenu.shortcut.modifiers || {},
                rawModifierBits = keyutil.modifiersToBits(rawModifiers),
                rawShortcut = {
                    modifiers: rawModifierBits
                },
                shortcutTableKey;

            if (rawKeyChar && rawKeyCode) {
                throw new Error("Menu entry specifies both key char and code");
            }

            if (rawKeyChar) {
                rawShortcut.keyChar = rawKeyChar;
                shortcutTableKey = "char-" + rawKeyChar;
            } else if (rawKeyCode) {
                if (!os.eventKeyCode.hasOwnProperty(rawKeyCode)) {
                    throw new Error("Menu entry specifies unknown key code: " + rawKeyCode);
                }

                rawShortcut.keyCode = os.eventKeyCode[rawKeyCode];
                shortcutTableKey = "code-" + rawKeyCode;
            } else {
                throw new Error("Menu entry does not specify a key for its shortcut");
            }

            // Check for conflicting menu shortcuts
            if (!shortcutTable.hasOwnProperty(shortcutTableKey)) {
                shortcutTable[shortcutTableKey] = {};
            }

            if (shortcutTable[shortcutTableKey][rawModifierBits]) {
                throw new Error("Menu entry shortcut duplicate: " + shortcutTableKey);
            } else {
                shortcutTable[shortcutTableKey][rawModifierBits] = true;
            }

            processedMenu.shortcut = new MenuShortcut(rawShortcut);
        }

        return new MenuItem(processedMenu);
    };

    /**
     * Exports a Photoshop readable object of this menu item
     * Omits the null values
     *
     * @return {object}
     */
    MenuItem.prototype.exportDescriptor = function () {
        var itemObj = _.omit(this.toObject(), _.isNull),
            shortcutDescriptor = this.shortcut && this.shortcut.exportDescriptor();

        if (itemObj.shortcut) {
            itemObj.shortcut = shortcutDescriptor;
        } else {
            delete itemObj.shortcut;
        }

        delete itemObj.submenuMap;
        delete itemObj.itemID;
        delete itemObj.id;

        if (itemObj.checked) {
            itemObj.checked = "on";
        } else {
            delete itemObj.checked;
        }

        if (!itemObj.type) {
            delete itemObj.type;
        }

        if (!itemObj.commandKind) {
            delete itemObj.commandKind;
        }

        if (this.submenu) {
            // Disable submenus with no items in them
            if (this.submenu.isEmpty()) {
                itemObj.enabled = false;
            }

            itemObj.submenu = this.submenu
                .map(function (submenuItem) {
                    return submenuItem.exportDescriptor();
                })
                .toArray();
        } else {
            delete itemObj.submenu;
        }

        return itemObj;
    };

    /**
     * Merge the given props into the submenu item with the given ID
     *
     * @param {string} submenuID string ID of the menu item within the submenu
     * @param {object} props object with properties to merge in to the MenuItem
     * @return {MenuItem}
     */
    MenuItem.prototype.updateSubmenuProps = function (submenuID, props) {
        var menuItem = this.byID(submenuID);
        if (!menuItem) {
            throw new Error("Unable to find submenu with ID " + submenuID);
        }

        var menuIndex = this.submenuMap.get(submenuID),
            nextMenuItem = menuItem.merge(props);

        // Immutable.List.merge does not play well with sparse arrays, so there
        // did not seem to be a way to use a single merge command with a POJSO
        return this.setIn(["submenu", menuIndex], nextMenuItem);
    };

    /**
     * Updates the menu item's children and then the menu item
     * Right now we only update enabled, but later on dynamic updating can be done here
     *
     * @param {Immutable.Map.<string, Immutable.List.<string>>} enablers
     * @param {Immutable.Map.<string, boolean>} rules
     *
     * @return {MenuItem}
     */
    MenuItem.prototype._update = function (enablers, rules) {
        var newSubmenu = null;
            
        if (this.submenu) {
            newSubmenu = this.submenu.map(function (subMenuItem) {
                return subMenuItem._update(enablers, rules);
            });
        }

        var itemRules = enablers.get(this.id, Immutable.List()),
            newEnabled;

        if (itemRules.isEmpty()) {
            newEnabled = false;
        } else {
            newEnabled = itemRules.every(function (rule) {
                return rules[rule];
            });
        }
        
        return this.merge({
            enabled: newEnabled,
            submenu: newSubmenu
        });
    };

    module.exports = MenuItem;
});
