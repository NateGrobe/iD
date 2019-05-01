import { event as d3_event, select as d3_select } from 'd3-selection';

import { t } from '../util/locale';

import { actionAddMidpoint } from '../actions/add_midpoint';
import { actionDeleteRelation } from '../actions/delete_relation';

import { behaviorBreathe } from '../behavior/breathe';
import { behaviorCopy } from '../behavior/copy';
import { behaviorHover } from '../behavior/hover';
import { behaviorLasso } from '../behavior/lasso';
import { behaviorPaste } from '../behavior/paste';
import { behaviorSelect } from '../behavior/select';

import { geoExtent, geoChooseEdge, geoPointInPolygon } from '../geo';
import { modeBrowse } from './browse';
import { modeDragNode } from './drag_node';
import { modeDragNote } from './drag_note';
import { osmNode, osmWay } from '../osm';
import * as Operations from '../operations/index';
import { uiEditMenu } from '../ui/edit_menu';
import { uiSelectionList } from '../ui/selection_list';
import { uiCmd } from '../ui/cmd';
import {
    utilArrayIntersection, utilEntityOrMemberSelector,
    utilEntitySelector, utilKeybinding
} from '../util';

// deprecation warning - Radial Menu to be removed in iD v3
import { uiRadialMenu } from '../ui/radial_menu';


var _relatedParent;


export function modeSelect(context, selectedIDs) {
    var mode = {
        id: 'select',
        button: 'browse'
    };

    var keybinding = utilKeybinding('select');
    var timeout = null;
    var behaviors = [
        behaviorCopy(context),
        behaviorPaste(context),
        behaviorBreathe(context),
        behaviorHover(context),
        behaviorSelect(context),
        behaviorLasso(context),
        modeDragNode(context).restoreSelectedIDs(selectedIDs).behavior,
        modeDragNote(context).behavior
    ];
    var inspector;
    var editMenu;
    var newFeature = false;
    var suppressMenu = true;
    var follow = false;


    var wrap = context.container()
        .select('.inspector-wrap');


    function singular() {
        if (selectedIDs && selectedIDs.length === 1) {
            return context.hasEntity(selectedIDs[0]);
        }
    }


    function checkSelectedIDs() {
        var ids = [];
        if (Array.isArray(selectedIDs)) {
            ids = selectedIDs.filter(function(id) {
                return context.hasEntity(id);
            });
        }

        if (ids.length) {
            selectedIDs = ids;
        } else {
            context.enter(modeBrowse(context));
        }
        return !!ids.length;
    }


    // find the common parent ways for nextVertex, previousVertex
    function commonParents() {
        var graph = context.graph();
        var commonParents = [];

        for (var i = 0; i < selectedIDs.length; i++) {
            var entity = context.hasEntity(selectedIDs[i]);
            if (!entity || entity.geometry(graph) !== 'vertex') {
                return [];  // selection includes some not vertexes
            }

            var currParents = graph.parentWays(entity).map(function(w) { return w.id; });
            if (!commonParents.length) {
                commonParents = currParents;
                continue;
            }

            commonParents = utilArrayIntersection(commonParents, currParents);
            if (!commonParents.length) {
                return [];
            }
        }

        return commonParents;
    }


    function singularParent() {
        var parents = commonParents();
        if (!parents || parents.length === 0) {
            _relatedParent = null;
            return null;
        }

        // relatedParent is used when we visit a vertex with multiple
        // parents, and we want to remember which parent line we started on.

        if (parents.length === 1) {
            _relatedParent = parents[0];  // remember this parent for later
            return _relatedParent;
        }

        if (parents.indexOf(_relatedParent) !== -1) {
            return _relatedParent;   // prefer the previously seen parent
        }

        return parents[0];
    }


    function closeMenu() {
        if (editMenu) {
            context.surface().call(editMenu.close);
        }
    }


    function positionMenu() {
        if (!editMenu) return;

        var entity = singular();
        if (entity && context.geometry(entity.id) === 'relation') {
            suppressMenu = true;
        } else {
            var point = context.mouse();
            var viewport = geoExtent(context.projection.clipExtent()).polygon();

            if (point && geoPointInPolygon(point, viewport)) {
                editMenu.center(point);
            } else {
                suppressMenu = true;
            }
        }
    }


    function showMenu() {
        closeMenu();
        if (editMenu) {
            context.surface().call(editMenu);
        }
    }


    function toggleMenu() {
        // deprecation warning - Radial Menu to be removed in iD v3
        if (d3_select('.edit-menu, .radial-menu').empty()) {
            positionMenu();
            showMenu();
        } else {
            closeMenu();
        }
    }


    mode.selectedIDs = function() {
        return selectedIDs;
    };


    mode.zoomToSelected = function() {
        var entity = singular();
        if (entity) {
            context.map().zoomToEase(entity);
        }
    };


    mode.reselect = function() {
        if (!checkSelectedIDs()) return;

        var surfaceNode = context.surface().node();
        if (surfaceNode.focus) {   // FF doesn't support it
            surfaceNode.focus();
        }

        positionMenu();
        if (!suppressMenu) {
            showMenu();
        }
    };


    mode.newFeature = function(val) {
        if (!arguments.length) return newFeature;
        newFeature = val;
        return mode;
    };


    mode.suppressMenu = function(val) {
        if (!arguments.length) return suppressMenu;
        suppressMenu = val;
        return mode;
    };


    mode.follow = function(val) {
        if (!arguments.length) return follow;
        follow = val;
        return mode;
    };


    mode.enter = function() {
        if (!checkSelectedIDs()) return;

        context.features().forceVisible(selectedIDs);

        var operations = Object.values(Operations)
            .map(function(o) { return o(selectedIDs, context); })
            .filter(function(o) { return o.available() && o.id !== 'delete' && o.id !== 'downgrade'; });

        var downgradeOperation = Operations.operationDowngrade(selectedIDs, context);
        // don't allow delete if downgrade is available
        var lastOperation = !context.inIntro() && downgradeOperation.available() ? downgradeOperation : Operations.operationDelete(selectedIDs, context);

        // deprecation warning - Radial Menu to be removed in iD v3
        var isRadialMenu = context.storage('edit-menu-style') === 'radial';
        if (isRadialMenu) {
            operations = operations.slice(0,7);
            operations.unshift(lastOperation);
        } else {
            operations.push(lastOperation);
        }

        operations.forEach(function(operation) {
            if (operation.behavior) {
                behaviors.push(operation.behavior);
            }
        });

        behaviors.forEach(context.install);

        keybinding
            .on(t('inspector.zoom_to.key'), mode.zoomToSelected)
            .on(['[', 'pgup'], previousVertex)
            .on([']', 'pgdown'], nextVertex)
            .on(['{', uiCmd('⌘['), 'home'], firstVertex)
            .on(['}', uiCmd('⌘]'), 'end'], lastVertex)
            .on(['\\', 'pause'], nextParent)
            .on('⎋', esc, true)
            .on('space', toggleMenu);

        d3_select(document)
            .call(keybinding);


        // deprecation warning - Radial Menu to be removed in iD v3
        editMenu = isRadialMenu
            ? uiRadialMenu(context, operations)
            : uiEditMenu(context, operations);

        context.ui().sidebar
            .select(singular() ? singular().id : null, newFeature);

        context.history()
            .on('undone.select', update)
            .on('redone.select', update);

        context.map()
            .on('move.select', closeMenu)
            .on('drawn.select', selectElements);

        context.surface()
            .on('dblclick.select', dblclick);


        selectElements();

        if (selectedIDs.length > 1) {
            var entities = uiSelectionList(context, selectedIDs);
            context.ui().sidebar.show(entities);
        }

        if (follow) {
            var extent = geoExtent();
            var graph = context.graph();
            selectedIDs.forEach(function(id) {
                var entity = context.entity(id);
                extent._extend(entity.extent(graph));
            });

            var loc = extent.center();
            context.map().centerEase(loc);
        } else if (singular() && singular().type === 'way') {
            context.map().pan([0,0]);  // full redraw, to adjust z-sorting #2914
        }

        timeout = window.setTimeout(function() {
            positionMenu();
            if (!suppressMenu) {
                showMenu();
            }
        }, 270);  /* after any centerEase completes */


        function update() {
            closeMenu();
            checkSelectedIDs();
        }


        function dblclick() {
            var target = d3_select(d3_event.target);

            var datum = target.datum();
            var entity = datum && datum.properties && datum.properties.entity;
            if (!entity) return;

            if (entity instanceof osmWay && target.classed('target')) {
                var choice = geoChooseEdge(context.childNodes(entity), context.mouse(), context.projection);
                var prev = entity.nodes[choice.index - 1];
                var next = entity.nodes[choice.index];

                context.perform(
                    actionAddMidpoint({ loc: choice.loc, edge: [prev, next] }, osmNode()),
                    t('operations.add.annotation.vertex')
                );

                d3_event.preventDefault();
                d3_event.stopPropagation();

            } else if (entity.type === 'midpoint') {
                context.perform(
                    actionAddMidpoint({ loc: entity.loc, edge: entity.edge }, osmNode()),
                    t('operations.add.annotation.vertex'));

                d3_event.preventDefault();
                d3_event.stopPropagation();
            }
        }


        function selectElements(drawn) {
            if (!checkSelectedIDs()) return;

            var surface = context.surface();
            var entity = singular();

            if (entity && context.geometry(entity.id) === 'relation') {
                suppressMenu = true;
                return;
            }

            surface.selectAll('.related')
                .classed('related', false);

            singularParent();
            if (_relatedParent) {
                surface.selectAll(utilEntitySelector([_relatedParent]))
                    .classed('related', true);
            }

            var selection = context.surface()
                .selectAll(utilEntityOrMemberSelector(selectedIDs, context.graph()));

            if (selection.empty()) {
                // Return to browse mode if selected DOM elements have
                // disappeared because the user moved them out of view..
                var source = d3_event && d3_event.type === 'zoom' && d3_event.sourceEvent;
                if (drawn && source && (source.type === 'mousemove' || source.type === 'touchmove')) {
                    context.enter(modeBrowse(context));
                }
            } else {
                selection
                    .classed('selected', true);
            }
        }


        function esc() {
            if (d3_select('.combobox').size()) return;
            context.enter(modeBrowse(context));
        }


        function firstVertex() {
            d3_event.preventDefault();
            var entity = singular();
            var parent = singularParent();
            var way;

            if (entity && entity.type === 'way') {
                way = entity;
            } else if (parent) {
                way = context.entity(parent);
            }

            if (way) {
                context.enter(
                    modeSelect(context, [way.first()]).follow(true)
                );
            }
        }


        function lastVertex() {
            d3_event.preventDefault();
            var entity = singular();
            var parent = singularParent();
            var way;

            if (entity && entity.type === 'way') {
                way = entity;
            } else if (parent) {
                way = context.entity(parent);
            }

            if (way) {
                context.enter(
                    modeSelect(context, [way.last()]).follow(true)
                );
            }
        }


        function previousVertex() {
            d3_event.preventDefault();
            var parent = singularParent();
            if (!parent) return;

            var way = context.entity(parent);
            var length = way.nodes.length;
            var curr = way.nodes.indexOf(selectedIDs[0]);
            var index = -1;

            if (curr > 0) {
                index = curr - 1;
            } else if (way.isClosed()) {
                index = length - 2;
            }

            if (index !== -1) {
                context.enter(
                    modeSelect(context, [way.nodes[index]]).follow(true)
                );
            }
        }


        function nextVertex() {
            d3_event.preventDefault();
            var parent = singularParent();
            if (!parent) return;

            var way = context.entity(parent);
            var length = way.nodes.length;
            var curr = way.nodes.indexOf(selectedIDs[0]);
            var index = -1;

            if (curr < length - 1) {
                index = curr + 1;
            } else if (way.isClosed()) {
                index = 0;
            }

            if (index !== -1) {
                context.enter(
                    modeSelect(context, [way.nodes[index]]).follow(true)
                );
            }
        }


        function nextParent() {
            d3_event.preventDefault();
            var parents = commonParents();
            if (!parents || parents.length < 2) return;

            var index = parents.indexOf(_relatedParent);
            if (index < 0 || index > parents.length - 2) {
                _relatedParent = parents[0];
            } else {
                _relatedParent = parents[index + 1];
            }

            var surface = context.surface();
            surface.selectAll('.related')
                .classed('related', false);

            if (_relatedParent) {
                surface.selectAll(utilEntitySelector([_relatedParent]))
                    .classed('related', true);
            }
        }
    };


    mode.exit = function() {
        if (timeout) window.clearTimeout(timeout);
        if (inspector) wrap.call(inspector.close);

        behaviors.forEach(context.uninstall);

        d3_select(document)
            .call(keybinding.unbind);

        closeMenu();
        editMenu = undefined;

        context.history()
            .on('undone.select', null)
            .on('redone.select', null);

        var surface = context.surface();

        surface
            .on('dblclick.select', null);

        surface
            .selectAll('.selected')
            .classed('selected', false);

        surface
            .selectAll('.related')
            .classed('related', false);

        context.map().on('drawn.select', null);
        context.ui().sidebar.hide();
        context.features().forceVisible([]);

        var entity = singular();
        if (newFeature &&
            entity &&
            entity.type === 'relation' &&
            // no tags
            Object.keys(entity.tags).length === 0 &&
            // no parent relations
            context.graph().parentRelations(entity).length === 0 &&
            // no members or one member with no role
            (entity.members.length === 0 || (entity.members.length === 1 && !entity.members[0].role))) {

            // the user added this relation but didn't edit it at all, so just delete it
            var deleteAction = actionDeleteRelation(entity.id, true /* don't delete untagged members */);
            context.perform(deleteAction, t('operations.delete.annotation.relation'));
        }
    };


    return mode;
}
