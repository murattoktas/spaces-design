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

define(function (require, exports) {
    "use strict";

    var Promise = require("bluebird"),
        Immutable = require("immutable"),
        _ = require("lodash");
        
    var photoshopEvent = require("adapter/lib/photoshopEvent"),
        artboardLib = require("adapter/lib/artboard"),
        descriptor = require("adapter/ps/descriptor"),
        documentLib = require("adapter/lib/document"),
        layerLib = require("adapter/lib/layer"),
        OS = require("adapter/os");

    var Layer = require("js/models/layer"),
        collection = require("js/util/collection"),
        documentActions = require("js/actions/documents"),
        log = require("js/util/log"),
        events = require("../events"),
        shortcuts = require("./shortcuts"),
        layerActionsUtil = require("js/util/layeractions"),
        locks = require("js/locks"),
        locking = require("js/util/locking"),
        headlights = require("js/util/headlights"),
        strings = require("i18n!nls/strings");

    var PS_MAX_NEST_DEPTH = 9;

    /**
     * @private
     * @type {Array.<string>} Properties to be included when requesting layer
     * descriptors from Photoshop.
     */
    var _layerProperties = [
        "layerID",
        "name",
        "visible",
        "layerLocking",
        "itemIndex",
        "background",
        "boundsNoEffects",
        "opacity",
        "layerFXVisible",
        "mode"
    ];

    /**
     * @private
     * @type {Array.<string>} Properties to be included if present when requesting
     * layer descriptors from Photoshop.
     */
    var _optionalLayerProperties = [
        "adjustment",
        "AGMStrokeStyleInfo",
        "textKey",
        "layerKind",
        "keyOriginType",
        "fillEnabled",
        "fillOpacity",
        "layerEffects",
        "proportionalScaling",
        "artboard",
        "artboardEnabled",
        "pathBounds",
        "smartObject",
        "globalAngle"
    ];

    /**
     * Get layer descriptors for the given layer references. Only the
     * properties listed in the arrays above will be included for performance
     * reasons. NOTE: All layer references must reference the same document.
     * 
     * @private
     * @param {Immutable.Iterable.<object>} references
     * @return {Promise.<Array.<object>>}
     */
    var _getLayersByRef = function (references) {
        var refObjs = references.reduce(function (refs, reference) {
            return refs.concat(_layerProperties.map(function (property) {
                return {
                    reference: reference,
                    property: property
                };
            }));
        }, []);

        var layerPropertiesPromise = descriptor.batchGetProperties(refObjs)
            .reduce(function (results, value, index) {
                var propertyIndex = index % _layerProperties.length;

                if (propertyIndex === 0) {
                    results.push({});
                }

                var result = results[results.length - 1],
                    property = _layerProperties[propertyIndex];

                result[property] = value;
                return results;
            }, []);

        var refObjsOptional = references.reduce(function (refs, reference) {
            return refs.concat(_optionalLayerProperties.map(function (property) {
                return {
                    reference: reference,
                    property: property
                };
            }));
        }, []);

        var optionalPropertiesPromise = descriptor.batchGetProperties(refObjsOptional, { continueOnError: true })
            .then(function (response) {
                var allResults = response[0];

                return allResults.reduce(function (results, value, index) {
                    var propertyIndex = index % _optionalLayerProperties.length;

                    if (propertyIndex === 0) {
                        results.push({});
                    }

                    var result = results[results.length - 1],
                        property = _optionalLayerProperties[propertyIndex];

                    if (value && value.hasOwnProperty(property)) {
                        result[property] = value[property];
                    }
                    
                    return results;
                }, []);
            });

        return Promise.join(layerPropertiesPromise, optionalPropertiesPromise,
            function (allProperties, allOptionalProperties) {
                return allProperties.map(function (properties, index) {
                    var optionalProperties = allOptionalProperties[index];
                    return _.assign(properties, optionalProperties);
                });
            });
    };

    /**
     * Emit an ADD_LAYER event with the layer ID, descriptor, index, whether
     * it should be selected, and whether the existing layer should be replaced.
     *
     * @param {Document} document
     * @param {number|Array.<number>} layerSpec
     * @param {boolean=} selected Default is true
     * @param {boolean=} replace Whether to replace the layer at the given index.
     *  If unspecified, the existing layer will only be replaced if it is an empty
     *  non-background layer.
     * @return {Promise}
     */
    var addLayersCommand = function (document, layerSpec, selected, replace) {
        if (typeof layerSpec === "number") {
            layerSpec = [layerSpec];
        }

        if (selected === undefined) {
            selected = true;
        }

        // Default replacement logic is to replace a single, empty non-background layer
        if (!replace) {
            replace = layerSpec.length === 1 &&
                (document.layers.hasArtboard ? document.layers.all.size === 3 : document.layers.all.size === 1);

            // The layer that we would replace must be a "no bounds" layer, not a background,
            // and if this document has an artboard, the layer must be selected
            if (replace) {
                var first = document.layers.hasArtboard ? document.layers.byID(2) : document.layers.all.first();
                replace = first && !first.isBackground && first.bounds && !first.bounds.area &&
                    (document.layers.hasArtboard && first.selected);
            }
        }

        var layerRefs = layerSpec.map(function (layerID) {
            return [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layerID)
            ];
        });

        return _getLayersByRef(layerRefs)
            .bind(this)
            .then(function (descriptors) {
                var payload = {
                    documentID: document.id,
                    layerIDs: layerSpec,
                    descriptors: descriptors,
                    selected: selected,
                    replace: replace
                };

                this.dispatch(events.document.ADD_LAYERS, payload);
            });
    };

    /**
     * Emit RESET_LAYERS with layer descriptors for all given layers.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @return {Promise}
     */
    var resetLayersCommand = function (document, layers) {
        var layerRefs = layers.map(function (layer) {
            return [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id)
            ];
        }).toArray();

        return _getLayersByRef(layerRefs)
            .bind(this)
            .then(function (descriptors) {
                var index = 0, // annoyingly, Immutable.Set.prototype.forEach does not provide an index
                    payload = {
                        documentID: document.id
                    };

                payload.layers = layers.map(function (layer) {
                    return {
                        layerID: layer.id,
                        descriptor: descriptors[index++]
                    };
                });

                this.dispatch(events.document.RESET_LAYERS, payload);
            });
    };

    /**
     * Calls reset on all smart object layers of the document
     * Depending on speed we can improve this by only resetting 
     * linked smart objects, or only resetting their boundaries
     *
     * @param {Document} document [description]
     * @return {Promise}
     */
    var resetLinkedLayersCommand = function (document) {
        if (!document) {
            return Promise.resolve();
        }

        var linkedLayers = document.layers.all.filter(function (layer) {
            return layer.kind === layer.layerKinds.SMARTOBJECT;
        });

        if (linkedLayers.isEmpty()) {
            return Promise.resolve();
        }

        return this.transfer(resetBounds, document, linkedLayers);
    };

    /**
     * Emit RESET_LAYERS_BY_INDEX with layer descriptors for all given layer indexes.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<number> | number} layerIndexes
     */
    var resetLayersByIndexCommand = function (document, layerIndexes) {
        var indexList = Immutable.Iterable.isIterable(layerIndexes) ? layerIndexes : Immutable.List.of(layerIndexes);

        var layerRefs = indexList.map(function (idx) {
            // adjust the index based on the existence of a background layer in the document
            var index = document.hasBackgroundLayer ? (idx - 1) : idx;

            return [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.index(index)
            ];
        }).toArray();

        return _getLayersByRef(layerRefs)
            .bind(this)
            .then(function (descriptors) {
                var payload = {
                        documentID: document.id,
                        descriptors: descriptors
                    };
                this.dispatch(events.document.RESET_LAYERS_BY_INDEX, payload);
            });
    };

    /**
     * Emit RESET_BOUNDS with bounds descriptors for the given layers.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @return {Promise}
     */
    var resetBoundsCommand = function (document, layers) {
        var propertyRefs = layers.map(function (layer) {
            var property;
            if (layer.isArtboard) {
                property = "artboard";
            } else if (layer.kind === layer.layerKinds.VECTOR) {
                property = "pathBounds";
            } else {
                property = "boundsNoEffects";
            }
            return [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id),
                {
                    ref: "property",
                    property: property
                }
            ];
        }).toArray();

        return descriptor.batchGet(propertyRefs)
            .bind(this)
            .then(function (bounds) {
                var index = 0, // annoyingly, Immutable.Set.prototype.forEach does not provide an index
                    payload = {
                        documentID: document.id
                    };

                payload.bounds = layers.map(function (layer) {
                    return {
                        layerID: layer.id,
                        descriptor: bounds[index++]
                    };
                });

                this.dispatch(events.document.RESET_BOUNDS, payload);
            });
    };

    /**
     * Selects the given layer with given modifiers
     *
     * @param {Document} document Owner document
     * @param {Layer|Immutable.Iterable.<Layer>} layerSpec Either a single layer that
     *  the selection is based on, or an array of such layers
     * @param {string} modifier Way of modifying the selection. Possible values
     *  are defined in `adapter/lib/layer.js` under `select.vals`
     *
     * @returns {Promise}
     */
    var selectLayerCommand = function (document, layerSpec, modifier) {
        if (layerSpec instanceof Layer) {
            layerSpec = Immutable.List.of(layerSpec);
        }

        if (document.unsupported) {
            return Promise.resolve();
        }

        var payload = {
            documentID: document.id
        };

        // TODO: Dispatch optimistically here for the other modifiers, and
        // eventually remove SELECT_LAYERS_BY_INDEX.
        var dispatchPromise = Promise.resolve();
        if (!modifier || modifier === "select") {
            payload.selectedIDs = collection.pluck(layerSpec, "id");
            dispatchPromise = this.dispatchAsync(events.document.SELECT_LAYERS_BY_ID, payload);
        }

        var layerRef = layerSpec
            .map(function (layer) {
                return layerLib.referenceBy.id(layer.id);
            })
            .unshift(documentLib.referenceBy.id(document.id))
            .toArray();

        var selectObj = layerLib.select(layerRef, false, modifier),
            selectPromise = descriptor.playObject(selectObj)
                .bind(this)
                .then(function () {
                    if (modifier && modifier !== "select") {
                        descriptor.getProperty(documentLib.referenceBy.id(document.id), "targetLayers")
                            .bind(this)
                            .then(function (targetLayers) {
                                payload.selectedIndices = _.pluck(targetLayers, "index");
                                this.dispatch(events.document.SELECT_LAYERS_BY_INDEX, payload);
                            });
                    }
                });

        return Promise.join(dispatchPromise, selectPromise);
    };

    /**
     * Renames the given layer
     *
     * @param {Document} document Owner document
     * @param {Layer} layer Layer to be renamed
     * @param {string} newName What to rename the layer
     * 
     * @returns {Promise}
     */
    var renameLayerCommand = function (document, layer, newName) {
        var payload = {
            documentID: document.id,
            layerID: layer.id,
            name: newName
        };

        var dispatchPromise = this.dispatchAsync(events.document.RENAME_LAYER, payload),
            layerRef = [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id)
            ],
            renameObj = layerLib.rename(layerRef, newName),
            renamePromise = descriptor.playObject(renameObj);

        return Promise.join(dispatchPromise, renamePromise);
    };

    /**
     * Deselects all layers in the given document, or in the current document if none is provided.
     * 
     * @param {document=} document
     * @returns {Promise}
     */
    var deselectAllLayersCommand = function (document) {
        if (document === undefined) {
            document = this.flux.store("application").getCurrentDocument();
        }

        // If document doesn't exist, or is a flat document
        if (!document || document.unsupported || document.layers.all.size === 1 &&
            document.layers.all.first().isBackground) {
            return Promise.resolve();
        }

        var payload = {
            documentID: document.id,
            selectedIDs: []
        };

        // FIXME: The descriptor below should be specific to the document ID
        var deselectPromise = descriptor.playObject(layerLib.deselectAll()),
            dispatchPromise = this.dispatchAsync(events.document.SELECT_LAYERS_BY_ID, payload);

        return Promise.join(dispatchPromise, deselectPromise);
    };

    /**
     * Selects all layers in the given document, or in the current document if none is provided.
     * 
     * @param {document=} document
     * @returns {Promise}
     */
    var selectAllLayersCommand = function (document) {
        if (document === undefined) {
            document = this.flux.store("application").getCurrentDocument();
        }

        // If document doesn't exist, or is a flat document
        if (!document || document.unsupported || document.layers.all.isEmpty()) {
            return Promise.resolve();
        }

        return this.transfer(selectLayer, document, document.layers.all);
    };

    /**
     * Deletes the selected layers in the given document, or in the current document if none is provided
     *
     * @param {?document} document
     * @return {Promise}
     */
    var deleteSelectedLayersCommand = function (document) {
        if (document === undefined) {
            document = this.flux.store("application").getCurrentDocument();
        }
        
        // If there is no doc, a flat doc, or all layers are going to be deleted, cancel
        if (!document || document.unsupported || document.layers.all.isEmpty() ||
            !document.layers.selectedLayersDeletable) {
            return Promise.resolve();
        }

        var documentID = document.id,
            layers = document.layers.allSelected,
            layerIDs = collection.pluck(layers, "id"),
            deletePlayObject = layerLib.delete(layerLib.referenceBy.current),
            payload = {
                documentID: documentID,
                layerIDs: layerIDs
            },
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.DELETE_LAYERS,
                    target: documentLib.referenceBy.id(documentID)
                }
            };

        var dispatchPromise = this.dispatchAsync(events.document.DELETE_LAYERS, payload),
            deletePromise = locking.playWithLockOverride(document, layers, deletePlayObject, options, true);

        return Promise.join(dispatchPromise, deletePromise);
    };

    /**
     * Groups the currently active layers
     * 
     * @param {Document} document 
     * @return {Promise}
     */
    var groupSelectedLayersCommand = function (document) {
        var selectedLayers = document.layers.selected;

        // plugin hangs on call with no selection, so for now, we avoid calling it
        if (selectedLayers.size === 0) {
            return Promise.resolve();
        }

        // Don't let group deeper than 10 levels
        var nestingLimitExceeded = selectedLayers.some(function (layer) {
            return document.layers.maxDescendantDepth(layer) > PS_MAX_NEST_DEPTH;
        });

        if (nestingLimitExceeded) {
            return Promise.resolve();
        }

        return descriptor.playObject(layerLib.groupSelected())
            .bind(this)
            .then(function (groupResult) {
                var payload = {
                    documentID: document.id,
                    groupID: groupResult.layerSectionStart,
                    groupEndID: groupResult.layerSectionEnd,
                    groupname: groupResult.name
                };

                this.dispatch(events.document.GROUP_SELECTED, payload);
            });
    };

    /**
     * Groups the selected layers in the currently active document
     * 
     * @return {Promise}
     */
    var groupSelectedLayersInCurrentDocumentCommand = function () {
        var flux = this.flux,
            applicationStore = flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument();

        if (!currentDocument) {
            return Promise.resolve();
        }

        return this.transfer(groupSelected, currentDocument);
    };

    /**
     * Changes the visibility of layer
     *
     * @param {Document} document
     * @param {Layer} layer
     * @param {boolean} visible Whether to show or hide the layer

     * @returns {Promise}
     */
    var setVisibilityCommand = function (document, layer, visible) {
        var payload = {
                documentID: document.id,
                layerID: layer.id,
                visible: visible
            },
            command = visible ? layerLib.show : layerLib.hide,
            layerRef = [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id)
            ];

        var dispatchPromise = this.dispatchAsync(events.document.VISIBILITY_CHANGED, payload),
            visibilityPromise = descriptor.playObject(command.apply(this, [layerRef]));

        return Promise.join(dispatchPromise, visibilityPromise);
    };

    /**
     * Unlocks the background layer of the document
     * FIXME: Does not care about the document reference
     *
     * @param {Document} document
     * @param {Layer} layer
     * @returns {Promise}
     */
    var _unlockBackgroundLayer = function (document, layer) {
        return descriptor.playObject(layerLib.unlockBackground(layer.id))
            .bind(this)
            .then(function (event) {
                var layerID = event.layerID;
                return this.transfer(addLayers, document, layerID, true, true);
            });
    };

    /**
     * Changes the lock state of layer
     *
     * @param {Document} document
     * @param {Layer} layer
     * @param {boolean} locked Whether all properties of layer is to be locked
     *
     * @returns {Promise}
     */
    var setLockingCommand = function (document, layer, locked) {
        var payload = {
                documentID: document.id,
                layerID: layer.id,
                locked: locked
            },
            layerRef = [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id)
            ];

        var dispatchPromise = this.dispatchAsync(events.document.LOCK_CHANGED, payload),
            lockPromise;
        if (layer.isBackground) {
            lockPromise = _unlockBackgroundLayer.call(this, document, layer);
        } else {
            lockPromise = descriptor.playObject(layerLib.setLocking(layerRef, locked));
        }

        return Promise.join(dispatchPromise, lockPromise);
    };

    /**
     * Set the opacity of the given layers.
     * 
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @param {number} opacity Opacity as a percentage
     * @param {boolean=} coalesce Whether to coalesce this operation's history state
     * @return {Promise}
     */
    var setOpacityCommand = function (document, layers, opacity, coalesce) {
        var payload = {
                documentID: document.id,
                layerIDs: collection.pluck(layers, "id"),
                opacity: opacity
            },
            playObjects = layers.map(function (layer) {
                var layerRef = [
                    documentLib.referenceBy.id(document.id),
                    layerLib.referenceBy.id(layer.id)
                ];

                return layerLib.setOpacity(layerRef, opacity);
            }),
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.CHANGE_LAYER_OPACITY,
                    target: documentLib.referenceBy.id(document.id),
                    coalesce: !!coalesce
                },
                paintOptions: {
                    immediateUpdate: true,
                    quality: "draft"
                }
            };

        var dispatchPromise = this.dispatchAsync(events.document.OPACITY_CHANGED, payload),
            opacityPromise = locking.playWithLockOverride(document, layers, playObjects.toArray(), options);

        return Promise.join(dispatchPromise, opacityPromise);
    };

    /**
     * Set the lock status of the selected layers in the current document as
     * specified.
     * 
     * @param {boolean} locked Whether to lock or unlock the selected layers
     * @return {Promise}
     */
    var _setLockingInCurrentDocument = function (locked) {
        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument();

        if (!currentDocument) {
            return Promise.resolve();
        }

        var lockPromises = currentDocument.layers.selected.map(function (layer) {
            return this.transfer(setLocking, currentDocument, layer, locked);
        }, this).toArray();

        return Promise.all(lockPromises);
    };

    /**
     * Lock the selected layers in the current document.
     * 
     * @return {Promise}
     */
    var lockSelectedInCurrentDocumentCommand = function () {
        return _setLockingInCurrentDocument.call(this, true);
    };

    /**
     * Unlock the selected layers in the current document.
     * 
     * @return {Promise}
     */
    var unlockSelectedInCurrentDocumentCommand = function () {
        return _setLockingInCurrentDocument.call(this, false);
    };

    var _getLayerIDsForDocument = function (doc) {
        var layerCount = doc.numberOfLayers,
            startIndex = (doc.hasBackgroundLayer ? 0 : 1),
            layerRefs = _.range(layerCount, startIndex - 1, -1).map(function (i) {
                return [
                    documentLib.referenceBy.id(doc.documentID),
                    layerLib.referenceBy.index(i)
                ];
            });
        
        return descriptor.batchGetProperty(layerRefs, "layerID");
    };

    /**
     * Moves the given layers to their given position
     * In Photoshop images, targetIndex 0 means bottom of the document, and will throw if
     * it is a background layer, targetIndex n, where n is the number of layers, means top of the 
     * document. Hidden endGroup layers also count in the index, and are used to tell between whether
     * to put next to the group, or inside the group as last element
     *
     * @param {number} documentID Owner document ID
     * @param {number|Immutable.Iterable.<number>} layerSpec Either an ID of single layer that
     *  the selection is based on, or an array of such layer IDs
     * @param {number} targetIndex Target index where to drop the layers
     *
     * @return {Promise} Resolves to the new ordered IDs of layers, or rejects if targetIndex
     * is invalid, as example when it is a child of one of the layers in layer spec
     **/
    var reorderLayersCommand = function (documentID, layerSpec, targetIndex) {
        if (!Immutable.Iterable.isIterable(layerSpec)) {
            layerSpec = Immutable.List.of(layerSpec);
        }
        
        var documentRef = documentLib.referenceBy.id(documentID),
            layerRef = layerSpec
                .map(function (layerID) {
                    return layerLib.referenceBy.id(layerID);
                })
                .unshift(documentRef)
                .toArray();

        var targetRef = layerLib.referenceBy.index(targetIndex),
            reorderObj = layerLib.reorder(layerRef, targetRef);

        return descriptor.playObject(reorderObj)
            .bind(this)
            .then(function () {
                return descriptor.get(documentRef)
                    .bind(this)
                    .then(function (doc) {
                        return _getLayerIDsForDocument(doc)
                            .then(function (layerIDs) {
                                var payload = {
                                    documentID: documentID,
                                    layerIDs: layerIDs
                                };

                                this.dispatch(events.document.REORDER_LAYERS, payload);
                            }.bind(this));
                    });
            });
    };

    /**
     * Set the blend mode of the given layers.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @param {string} mode Blend mode ID
     * @return {Promise}
     */
    var setBlendModeCommand = function (document, layers, mode) {
        var documentRef = documentLib.referenceBy.id(document.id),
            layerIDs = collection.pluck(layers, "id"),
            layerRef = layerIDs
                .map(function (layerID) {
                    return layerLib.referenceBy.id(layerID);
                })
                .unshift(documentRef)
                .toArray(),
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.SET_BLEND_MODE,
                    target: documentLib.referenceBy.id(document.id)
                }
            };

        var payload = {
            documentID: document.id,
            layerIDs: layerIDs,
            mode: mode
        };

        var dispatchPromise = this.dispatchAsync(events.document.BLEND_MODE_CHANGED, payload),
            blendPromise = locking.playWithLockOverride(document, layers,
                layerLib.setBlendMode(layerRef, mode), options);

        return Promise.join(dispatchPromise, blendPromise);
    };

    /**
     * Sets the given layers' proportional flag
     * @private
     * @param {Document} document Owner document
     * @param {Layer|Immutable.Iterable.<Layer>} layerSpec Either a Layer reference or array of Layers
     * @param {boolean=} proportional make the size change proportionally 
     *
     * @returns {Promise}
     */
    var setProportionalCommand = function (document, layerSpec, proportional) {
        layerSpec = layerSpec.filterNot(function (layer) {
            return layer.kind === layer.layerKinds.GROUPEND;
        });

        var layerIDs = collection.pluck(layerSpec, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                proportional: proportional
            },
            options = {
                paintOptions: {
                    immediateUpdate: true,
                    quality: "draft"
                },
                historyStateInfo: {
                    name: strings.ACTIONS.SET_PROPORTIONAL_SCALE,
                    target: documentLib.referenceBy.id(document.id)
                }
            };

        var dispatchPromise = Promise.bind(this).then(function () {
            this.dispatch(events.document.SET_LAYERS_PROPORTIONAL, payload);
        });

        var layerPlayObjects = layerSpec.map(function (layer) {
            var layerRef = layerLib.referenceBy.id(layer.id),
            proportionalObj = layerLib.setProportionalScaling(layerRef, proportional);

            return {
                layer: layer,
                playObject: proportionalObj
            };
        }, this);

        var sizePromise = layerActionsUtil.playLayerActions(document, layerPlayObjects, true, options);

        return Promise.join(dispatchPromise, sizePromise);
    };

    /**
     * Default Artboard size 
     * @const 
     *
     * @type {object} 
     */
    var DEFAULT_ARTBOARD_BOUNDS = {
        bottom: 1960,
        top: 0,
        right: 1080,
        left: 0
    };

    /**
     * Create a new Artboard on the PS doc
     * if no bounds are provided we place this 100 px to the right of selected artboard 
     * or we add a default sized "iphone" artboard 
     * otherwise passed in bounds are used
     *
     * @param {Bounds?} artboardBounds where to place the new artboard
     * @return {Promise}
     */
    var createArtboardCommand = function (artboardBounds) {
        var document = this.flux.store("application").getCurrentDocument(),
            artboards = document.layers.all.filter(function (layer) {
                return layer.isArtboard;
            }),
            layerRef = layerLib.referenceBy.none,
            finalBounds;

        if (artboardBounds !== undefined) {
            finalBounds = artboardBounds.toJS();
        } else if (artboards.isEmpty()) {
            // If there are no artboards selected, use current selection
            layerRef = layerLib.referenceBy.current;
            finalBounds = DEFAULT_ARTBOARD_BOUNDS;
        } else {
            var layer = artboards.reduce(function (selectedLayer, currentLayer) {
                if (currentLayer.bounds.right > selectedLayer.bounds.right) {
                    return currentLayer;
                } else {
                    return selectedLayer;
                }
            }, artboards.first());

            var offset = layer.bounds.width + 100;
            
            finalBounds = {
                    top: layer.bounds.top,
                    bottom: layer.bounds.bottom,
                    left: layer.bounds.left + offset,
                    right: layer.bounds.right + offset
                };
        }

        var createObj = artboardLib.make(layerRef, finalBounds);
        
        return descriptor.playObject(createObj)
            .bind(this)
            .then(function () {
                log.debug("Warning: calling updateDocument to add a single artboard is very slow!");
                return this.transfer(documentActions.updateDocument, document.id);
            });
    };

    /**
     * Copy into the given document a set of layers, possibly from another document.
     *
     * @param {Document} document
     * @param {Document} fromDocument
     * @param {Immutable.Iterable.<Layer>} fromLayers
     * @return {Promise}
     */
    var duplicateCommand = function (document, fromDocument, fromLayers) {
        if (fromLayers.isEmpty()) {
            return Promise.resolve();
        }

        var duplicatePlayObjects = fromLayers.map(function (fromLayer) {
            var toRef = documentLib.referenceBy.id(document.id),
                fromDocumentRef = documentLib.referenceBy.id(fromDocument.id),
                fromLayerRef = layerLib.referenceBy.id(fromLayer.id),
                fromRef = [
                    fromLayerRef,
                    fromDocumentRef
                ];

            return layerLib.duplicate(fromRef, toRef);
        });

        var duplicateOptions = {
            historyStateInfo: {
                name: strings.ACTIONS.DUPLICATE_LAYERS,
                target: documentLib.referenceBy.id(document.id)
            }
        };

        return descriptor.batchPlayObjects(duplicatePlayObjects.toArray(), duplicateOptions)
            .bind(this)
            .then(function (results) {
                // NOTE: The following update could be implemented completely optimistically if
                // we leveraged information in the from-layer models and the results of the
                // duplicate call, which contains information about the new layer names.
                var allLayerIDs = collection.pluck(results, "ID")
                    .reduce(function (allLayerIDs, layerIDs) {
                        return allLayerIDs.concat(layerIDs);
                    }, []);

                return this.transfer(addLayers, document, allLayerIDs);
            });
    };

    /**
     * Listen for Photohop layer events.
     *
     * @return {Promise}
     */
    var beforeStartupCommand = function () {
        var applicationStore = this.flux.store("application"),
            toolStore = this.flux.store("tool");

        descriptor.addListener("make", function (event) {
            var target = photoshopEvent.targetOf(event),
                currentDocument;

            switch (target) {
            case "layer":
            case "contentLayer":
            case "textLayer":
                // A layer was added
                currentDocument = applicationStore.getCurrentDocument();
                if (!currentDocument) {
                    log.warn("Received layer make event without a current document", event);
                    return;
                }

                if (typeof event.layerID === "number") {
                    this.flux.actions.layers.addLayers(currentDocument, event.layerID);
                } else {
                    this.flux.actions.documents.updateDocument(currentDocument.id);
                }

                var currentTool = toolStore.getCurrentTool();

                // Log the tool used to make this layer
                if (currentTool) {
                    var toolID = currentTool.id;
                    headlights.logEvent("tools", "create", toolID);
                }

                break;
            }
        }.bind(this));

        descriptor.addListener("set", function (event) {
            var target = photoshopEvent.targetOf(event),
                currentDocument;

            switch (target) {
            case "textLayer":
                // A layer was added
                currentDocument = applicationStore.getCurrentDocument();
                if (!currentDocument) {
                    log.warn("Received layer set event without a current document", event);
                    return;
                }

                this.flux.actions.layers.resetLayers(currentDocument, currentDocument.layers.selected);
                break;
            }
        }.bind(this));

        descriptor.addListener("selectedLayer", function (event) {
            var applicationStore = this.flux.store("application");

            var payload = {
                documentID: applicationStore.getCurrentDocumentID(),
                selectedIDs: [event.layerID]
            };

            this.dispatch(events.document.SELECT_LAYERS_BY_ID, payload);
        }.bind(this));

        // Listens to layer shift events caused by auto canvas resize feature of artboards
        // and shifts all the layers correctly
        descriptor.addListener("autoCanvasResizeShift", function (event) {
            var applicationStore = this.flux.store("application"),
                currentDocument = applicationStore.getCurrentDocument();
            
            if (currentDocument !== null) {
                var payload = {
                    documentID: applicationStore.getCurrentDocumentID(),
                    layerIDs: collection.pluck(currentDocument.layers.all, "id"),
                    position: {
                        x: event.to.value.horizontal,
                        y: event.to.value.vertical
                    }
                };

                this.dispatch(events.document.TRANSLATE_LAYERS, payload);
            }
        }.bind(this));

        var updateShapeLayerBounds = function () {
            var applicationStore = this.flux.store("application"),
                currentDocument = applicationStore.getCurrentDocument();

            if (currentDocument !== null) {
                var layers = currentDocument.layers.selected;
                
                this.flux.actions.layers.resetBounds(currentDocument, layers);
            }
        }.bind(this);

        // Listeners for shift / option shape drawing
        descriptor.addListener("addTo", updateShapeLayerBounds);
        descriptor.addListener("subtractFrom", updateShapeLayerBounds);
        // Supposed to be intersectWith, but it's defined twice and interfaceWhite is defined before
        descriptor.addListener("interfaceWhite", updateShapeLayerBounds);

        // Listener for path changes
        descriptor.addListener("pathOperation", function (event) {
            // We don't reset the bounds after newPath commands because those
            // also trigger a layer "make" event, and so the new layer model
            // will be initialized with the correct bounds.
            if (event.command === "pathChange") {
                var applicationStore = this.flux.store("application"),
                    currentDocument = applicationStore.getCurrentDocument(),
                    currentLayers = currentDocument.layers,
                    layerIDs = _.pluck(_.rest(event.null.ref), "id"),
                    layers = Immutable.List(layerIDs.map(currentLayers.byID, currentLayers));

                this.flux.actions.layers.resetBounds(currentDocument, layers);
            }
        }.bind(this));

        // During path edit operations, deleting the last vector of a path
        // will delete the layer, and emit us a delete event
        // We listen to this, update the selection, and reset to superselect tool
        descriptor.addListener("delete", function (event) {
            var applicationStore = this.flux.store("application"),
                toolStore = this.flux.store("tool"),
                target = photoshopEvent.targetOf(event),
                currentDocument = applicationStore.getCurrentDocument();

            if (!currentDocument) {
                return;
            }

            if (target === "layer") {
                var payload = {
                    documentID: currentDocument.id,
                    // layerID is an array of IDs, despite the parameter name
                    layerIDs: Immutable.List(event.layerID) || Immutable.List()
                };
                
                this.dispatch(events.document.DELETE_LAYERS, payload);

                descriptor.getProperty("document", "targetLayers")
                    .bind(this)
                    .then(function (targetLayers) {
                        var layerIndices = _.pluck(targetLayers, "index"),
                            selectPayload = {
                                documentID: currentDocument.id,
                                selectedIndices: layerIndices
                            };
                        
                        this.dispatch(events.document.SELECT_LAYERS_BY_INDEX, selectPayload);
                        this.flux.actions.tools.select(toolStore.getDefaultTool());
                    });
            }
        }.bind(this));

        var deleteFn = function () {
            // Note: shortcuts are executed iff some CEF element does not have focus.
            // In particular, this means that if is no active element but there _is_
            // selected text (e.g., in a disabled text input), the shortcut is executed.
            // But it is surprising to the user to have a layer deleted when text is
            // selected, so we decline the delete layers in this particular case.
            var selection = window.getSelection();
            if (selection.type !== "Range") {
                this.flux.actions.layers.deleteSelected();
            }
        }.bind(this);

        var backspacePromise = this.transfer(shortcuts.addShortcut, OS.eventKeyCode.BACKSPACE, {}, deleteFn),
            deletePromise = this.transfer(shortcuts.addShortcut, OS.eventKeyCode.DELETE, {}, deleteFn);

        return Promise.join(backspacePromise, deletePromise);
    };

    var selectLayer = {
        command: selectLayerCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var rename = {
        command: renameLayerCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var selectAll = {
        command: selectAllLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var deselectAll = {
        command: deselectAllLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var deleteSelected = {
        command: deleteSelectedLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var groupSelected = {
        command: groupSelectedLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var groupSelectedInCurrentDocument = {
        command: groupSelectedLayersInCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var setVisibility = {
        command: setVisibilityCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var setLocking = {
        command: setLockingCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var setOpacity = {
        command: setOpacityCommand,
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var lockSelectedInCurrentDocument = {
        command: lockSelectedInCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var unlockSelectedInCurrentDocument = {
        command: unlockSelectedInCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var reorderLayers = {
        command: reorderLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var setBlendMode = {
        command: setBlendModeCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var addLayers = {
        command: addLayersCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var resetLayers = {
        command: resetLayersCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var resetLayersByIndex = {
        command: resetLayersByIndexCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var resetBounds = {
        command: resetBoundsCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var setProportional = {
        command: setProportionalCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var resetLinkedLayers = {
        command: resetLinkedLayersCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var beforeStartup = {
        command: beforeStartupCommand,
        reads: [locks.PS_DOC, locks.PS_APP],
        writes: [locks.JS_DOC, locks.JS_SHORTCUT, locks.JS_POLICY, locks.PS_APP]
    };

    var createArtboard = {
        command: createArtboardCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var duplicate = {
        command: duplicateCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    exports.select = selectLayer;
    exports.rename = rename;
    exports.selectAll = selectAll;
    exports.deselectAll = deselectAll;
    exports.deleteSelected = deleteSelected;
    exports.groupSelected = groupSelected;
    exports.groupSelectedInCurrentDocument = groupSelectedInCurrentDocument;
    exports.setVisibility = setVisibility;
    exports.setLocking = setLocking;
    exports.setOpacity = setOpacity;
    exports.lockSelectedInCurrentDocument = lockSelectedInCurrentDocument;
    exports.unlockSelectedInCurrentDocument = unlockSelectedInCurrentDocument;
    exports.reorder = reorderLayers;
    exports.setBlendMode = setBlendMode;
    exports.addLayers = addLayers;
    exports.resetLayers = resetLayers;
    exports.resetLayersByIndex = resetLayersByIndex;
    exports.resetBounds = resetBounds;
    exports.setProportional = setProportional;
    exports.beforeStartup = beforeStartup;
    exports.createArtboard = createArtboard;
    exports.resetLinkedLayers = resetLinkedLayers;
    exports.duplicate = duplicate;

    exports._getLayersByRef = _getLayersByRef;
});
