/*
 * Copyright (c) 2015 Adobe Systems Incorporated. All rights reserved.
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

define(function (require, exports) {
    "use strict";

    var Immutable = require("immutable");

    var descriptor = require("adapter").ps.descriptor,
        toolLib = require("adapter").lib.tool,
        UI = require("adapter").ps.ui;

    var Color = require("js/models/color"),
        log = require("js/util/log"),
        locks = require("js/locks"),
        layerActions = require("../layers"),
        documentActions = require("../documents");

    /**
     * Layers can be moved using type tool by holding down cmd
     * We need to reset the bounds correctly during this
     */
    var _typeChangedHandler,
        _layerCreatedHandler,
        _layerDeletedHandler,
        _toolModalStateChangedHandler;

    /**
     * The createdTextLayer event results in an addLayers action which may or
     * may not replace an empty layer. Whether or not it does is recorded in
     * this variable. If we later receive a deletedTextLayer event, we will
     * only call removeLayer to undo the previous layer addition if there was
     * no replacement. Otherwise, if there was some replacement, we call
     * updateDocument instead becuase it's too hard to figure out what the new
     * correct layer state is.
     *
     * @private
     * @type {boolean}
     */
    var _layersReplaced = false;

    /**
     * The deleteTextLayer event is handled by removing the corresponding layer
     * model. This event may be followed by an event that indicates a modal type
     * state was canceled. This event should be handled by resetting the selected
     * layers, but only if the layer wasn't just deleted. This records the deleted
     * layer ID, and is used to short-circuit the modal cancelation handler.
     *
     * @private
     * @param {?number}
     */
    var _layerDeleted = null;

    /**
     * Extract style properties from modal text events.
     *
     * @private
     * @param {object} event
     * @return {?object}
     */
    var _getPropertiesFromEvent = function (event) {
        var style = event.currentTextStyle;
        if (!style) {
            return null;
        }

        return {
            textSize: style.hasOwnProperty("size") ? style.size : null,
            postScriptName: style.hasOwnProperty("fontName") ? style.fontName : null,
            color: style.hasOwnProperty("color") ? Color.fromPhotoshopColorObj(style.color, 100) : null,
            tracking: style.hasOwnProperty("tracking") ? style.tracking : null,
            alignment: style.hasOwnProperty("align") ? style.align._value : null,
            leading: style.autoLeading ? -1 : (style.hasOwnProperty("leading") ? style.leading : null)
        };
    };

    var firstLaunch = true;

    /**
     * Add modal type event handlers and set default type styles.
     *
     * @return {Promise}
     */
    var select = function () {
        // If this is set, means we didn't get to deselect the tool last time
        if (_typeChangedHandler) {
            descriptor.removeListener("updateTextProperties", _typeChangedHandler);
        }
        if (_layerCreatedHandler) {
            descriptor.removeListener("createTextLayer", _layerCreatedHandler);
        }
        if (_layerDeletedHandler) {
            descriptor.removeListener("deleteTextLayer", _layerDeletedHandler);
        }
        if (_toolModalStateChangedHandler) {
            descriptor.removeListener("toolModalStateChanged", _toolModalStateChangedHandler);
        }

        _typeChangedHandler = this.flux.actions.tool.type.updateTextPropertiesHandlerThrottled.bind(this);
        descriptor.addListener("updateTextProperties", _typeChangedHandler);

        _layerCreatedHandler = function (event) {
            var applicationStore = this.flux.store("application"),
                document = applicationStore.getCurrentDocument();

            if (!document) {
                log.error("Unexpected createTextLayer event: no active document");
                return;
            }

            var layerID = event.layerID,
                currentLayer = document.layers.byID(layerID);

            if (currentLayer) {
                log.warn("Unexpected createTextLayer event for layer " + layerID);
                this.flux.actions.layers.resetLayers(document, currentLayer);
            } else {
                _layersReplaced = false;

                this.flux.actions.layers.addLayers(document, layerID, true)
                    .bind(this)
                    .then(function (layersReplaced) {
                        _layersReplaced = layersReplaced;

                        var properties = _getPropertiesFromEvent(event);
                        if (!properties) {
                            return;
                        }

                        var documentStore = this.flux.store("document"),
                            nextDocument = documentStore.getDocument(document.id),
                            layer = nextDocument.layers.byID(layerID),
                            layers = Immutable.List.of(layer);

                        this.flux.actions.type.updatePropertiesThrottled(document, layers, properties);
                    });
            }
        }.bind(this);
        descriptor.addListener("createTextLayer", _layerCreatedHandler);

        _layerDeletedHandler = function (event) {
            _layerDeleted = event.layerID;
            this.flux.actions.tool.type.handleDeletedLayer(event, _layersReplaced);
        }.bind(this);
        descriptor.addListener("deleteTextLayer", _layerDeletedHandler);

        _toolModalStateChangedHandler = function (event) {
            if (event.kind._value === "tool" && event.tool.ID === "txBx" &&
                event.state._value === "exit" && event.reason._value === "cancel") {
                // If there was a deleteTextLayer event, we've already updated the model.
                if (_layerDeleted) {
                    _layerDeleted = null;
                    return;
                }

                this.flux.actions.tool.type.handleTypeModalStateCanceled();
            }
        }.bind(this);
        descriptor.addListener("toolModalStateChanged", _toolModalStateChangedHandler);

        return UI.setSuppressTargetPaths(true)
            .bind(this)
            .then(function () {
                if (firstLaunch) {
                    firstLaunch = false;

                    return descriptor.playObject(toolLib.resetTypeTool("left", "Myriad Pro", 16, [0, 0, 0]));
                }
            });
    };
    select.action = {
        reads: [],
        writes: [locks.PS_APP, locks.PS_TOOL],
        transfers: [],
        modal: true
    };

    /**
     * Remove modal type event handlers.
     *
     * @return {Promise}
     */
    var deselect = function () {
        descriptor.removeListener("updateTextProperties", _typeChangedHandler);
        descriptor.removeListener("createTextLayer", _layerCreatedHandler);
        descriptor.removeListener("deleteTextLayer", _layerDeletedHandler);
        descriptor.removeListener("toolModalStateChanged", _toolModalStateChangedHandler);
        
        _typeChangedHandler = null;
        _layerCreatedHandler = null;
        _layerDeletedHandler = null;
        _toolModalStateChangedHandler = null;

        return UI.setSuppressTargetPaths(false);
    };
    deselect.action = {
        reads: [],
        writes: [locks.PS_APP],
        transfers: [],
        modal: true
    };

    /**
     * Handles updateTextProperties events, which are emitted during the type modal
     * tool state to indicate the text properties of the current text selection or
     * cursor position.
     *
     * @param {object} event
     * @return {Promise}
     */
    var updateTextPropertiesHandler = function (event) {
        var documentStore = this.flux.store("application"),
            currentDocument = documentStore.getCurrentDocument(),
            layers = currentDocument.layers.allSelected,
            typeLayers = layers.filter(function (layer) {
                return layer.isText;
            });

        if (typeLayers.isEmpty()) {
            return Promise.resolve();
        }

        var properties = _getPropertiesFromEvent(event);

        return this.transfer("type.updateProperties", currentDocument, typeLayers, properties);
    };
    updateTextPropertiesHandler.action = {
        reads: [locks.JS_APP, locks.JS_DOC],
        writes: [],
        transfers: ["type.updateProperties"],
        modal: true
    };

    /**
     * Handle the deleteTextLayer event for the type tool by removing the
     * client-side layer model.
     *
     * @param {object} event
     * @param {boolean} layersReplaced If true, completely reset the document
     *  instead of just deleting the referenced layer.
     * @return {Promise}
     */
    var handleDeletedLayer = function (event, layersReplaced) {
        var applicationStore = this.flux.store("application"),
            document = applicationStore.getCurrentDocument();

        if (!document) {
            throw new Error("Unexpected deleteTextLayer event: no active document");
        }

        if (layersReplaced) {
            return this.transfer(documentActions.updateDocument);
        } else {
            var layerID = event.layerID,
                layer = document.layers.byID(layerID);

            if (!layer) {
                log.warn("Unable to handle deleted text layer because it does not exist: " + layerID);
                return this.transfer(documentActions.updateDocument);
            }

            return this.transfer(layerActions.removeLayers, document, layer, true);
        }
    };
    handleDeletedLayer.action = {
        reads: [locks.JS_APP, locks.JS_DOC],
        writes: [],
        modal: true,
        transfers: ["layers.removeLayers", "documents.updateDocument"]
    };

    /**
     * Handle the toolModalStateChanged event, when it indicates a type tool
     * cancelation, by resetting the selected layers.
     *
     * @return {Promise}
     */
    var handleTypeModalStateCanceled = function () {
        var application = this.flux.store("application"),
            document = application.getCurrentDocument();

        if (!document) {
            throw new Error("Unexpected toolModalStateChanged event: no active document");
        }

        return this.transfer(layerActions.resetLayers, document, document.layers.selected);
    };
    handleTypeModalStateCanceled.action = {
        reads: [locks.JS_APP, locks.JS_DOC],
        writes: [],
        modal: true,
        transfers: ["layers.resetLayers"],
        post: ["verify.layers.verifySelectedBounds"]
    };

    exports.select = select;
    exports.deselect = deselect;
    exports.updateTextPropertiesHandler = updateTextPropertiesHandler;
    exports.handleDeletedLayer = handleDeletedLayer;
    exports.handleTypeModalStateCanceled = handleTypeModalStateCanceled;
});
