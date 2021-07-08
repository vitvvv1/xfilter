/*!
 *  xfilter 0.2.3
 *  http://att.github.io/xfilter/
 *  Copyright (c) 2012-2013 AT&T Intellectual Property
 *
 *  Licensed under the MIT License
 *  https://github.com/att/xfilter/blob/master/LICENSE
 */
(function() { function _xfilter() {
'use strict';

xfilter.version = '0.2.3';


function xfilter(server) {
    var _engine;
    var _fields, _xform, _filters = {}, _groups = {}, _data, _group_id = 17;
    var _start_time, _resolution; // in ms (since epoch for start)

    function query_url(q) {
        return server + '/' + q;
    }

    function create_group(dimension) {
        var _id = _group_id++, _anchor = {id: _id, dimension: dimension, values: null};
        _groups[_id] = _anchor;
        var group = {
            categorical: function() {
                // unclear how much engines will share impl
                return this;
            },
            dispose: function() {
                delete _groups[_id];
                _anchor.values = null;
                return this;
            },
            all: function() {
                return _anchor.values;
            }
        };
        if(xf.engine().augment_group)
            group = xf.engine().augment_group(_anchor, group);
        return group;
    }

    var xf = {};

    xf.dimension = function(field) {
        if(!Object.keys(_fields).length)
            throw new Error('no schema (not started)');
        if(!_fields[field])
            throw new Error('field ' + field + ' not found in schema');

        function toValues(v) {
            if(!_xform[field])
                return v;
            if(v instanceof Array)
                return v.map(toValues);
            return _xform[field].to(v);
        }

        return {
            filter: function(v) {
                if(v !== null)
                    throw new Error('unexpected non-null filter()');
                delete _filters[field];
                return this;
            },
            filterExact: function(val) {
                val = toValues(val);
                _filters[field] = {type: 'set', target: [val]};
                return this;
            },
            filterMultiple: function(vals) { // not in ordinary crossfilter
                vals = toValues(vals);
                _filters[field] = {type: 'set', target: vals};
                return this;
            },
            filterRange: function(range) {
                range = toValues(range);
                _filters[field] = {type: 'interval', target: range};
                return this;
            },
            filterFunction: function() {
                throw new Error('filter functions not allowed');
            },
            dispose: function() {
                this.filter(null);
                return this;
            },
            group: function() {
                return create_group(field);
            }
        };
    };

    function validate(data) {
        function expect() {
            var d = data;
            for(var i = 0; i < arguments.length; ++i) {
                if(!d[arguments[i]]) {
                    console.log('expected data.' + Array.prototype.slice.call(arguments, 0, i).join('.'));
                    return false;
                }
                d = d[arguments[i]];
            }
            return true;
        }
        expect('layers');
        expect('root', 'children');
    }

    function key_ascending(a, b) { // adapted from d3.ascending
        return a.key < b.key ? -1 : a.key > b.key ? 1 : a.key >= b.key ? 0 : NaN;
    }

    xf.commit = function() {
        var ids = Object.keys(_groups), qs = [];
        for(var id in _groups)
            qs.push(xf.engine().do_query(query_url, _filters, _groups[id]));
        return Promise.all(qs).then(function(results) {
            if(results.length !== qs.length)
                throw new Error('unexpected number of results ' + results.length);

            for(var i = 0; i < results.length; ++i) {
                var result = results[i],
                    id = ids[i],
                    group = _groups[id],
                    xform = _xform[group.dimension];
                group.values = xf.engine()
                    .unpack_result(result)
                    .sort(key_ascending)
                    .map(function(kv) {
                        return {key: xform ? xform.fro(kv.key, group.state) : kv.key, value: kv.value};
                    });
            }
            if(validate(result))
                _data = result;
            return results;
        });
    };

    xf.engine = function(_) {
        if(!arguments.length)
            return _engine;
        _engine = _;
        return xf;
    };

    xf.start = function() {
        return xf.engine().fetch_schema(query_url).then(function(result) {
            ({fields: _fields, xform: _xform} = result);
            _xform = _xform || {};
        });
    };

    return xf;
}

xfilter.nanocube_queries = function() {
    // var _start_time, _resolution;
    var _start_time2, _resolution2;
    var _dataset_name;
    function ms_mult(suffix) {
        var mult = 1;
        switch(suffix) {
        case 'w': mult *= 7;
        case 'd': mult *= 24;
        case 'h': mult *= 60;
        case 'm': mult *= 60;
        case 's': return mult*1000;
        default: return NaN;
        }
    }
    return {
        do_query: function(query_url, filters, group) {
            var parts = ['q'];
            var filter_parts = [];
            for(var f in filters) {
                if(group && group.dimension === f)
                    continue;
                var filter;
                switch(filters[f].type) {
                    case 'set':
                        filter = '\'' + f + '\',pathagg(p(' + filters[f].target.join('),p(') + '))';
                        break;
                    case 'interval':
                        let length = filters[f].target[1] - filters[f].target[0];
                        filter = 'intseq(' + filters[f].target[0] + ',24,' + length + ')';
                        break;
                }
                filter_parts.push('.b(' + filter + ')');
            }
            if(group.state)
                parts.push('(' + _dataset_name + '.b(\'' + group.dimension + '\',' + group.state.print() + ')' + filter_parts.join('') + ')');
            return d3.json(query_url(parts.join('')));
        },
        unpack_result: function(result) {
            var unpacked_results = [];
            for (let i = 0; i < result[0].numrows; i++) {
                var key = result[0].index_columns[0].values[i];
                var value =  result[0].measure_columns[0].values[i];
                unpacked_results.push({key: key, value: value})
            }
            return unpacked_results;
            // return result.root.children.map(function(pv) {
            //     return {key: pv.path[0], value: pv.val};
            // });
        },
        fetch_schema: function(query_url) {
            return d3.json(query_url('schema()')).then(function(schema) {
                var fields = {}, xform = {};

                _dataset_name = schema[0].name;

                schema[0].index_dimensions.forEach(function(f) {
                    fields[f.name] = f;
                    if(/^categorical/.test(f.hint)) {
                        var vn = [];
                        for(var vid in f.aliases)
                            vn[f.aliases[vid]] = vid;
                        xform[f.name] = {
                            to: function(v) {
                                return vn[v];
                            },
                            fro: function(v) {
                                return f.aliases[v] || 'foo';
                            }
                        };
                    }
                    else if(/^temporal/.test(f.hint)) {
                        var byTemporal = f.hint.split('|');
                        var byResolution = byTemporal[1].split('_');
                        var time = byResolution[0];
                        var resolution = byResolution[1];

                        _start_time2 = Date.parse(time);

                        var match;
                        if((match = /^([0-9]+)([a-z]+)$/.exec(resolution))) {
                            var mult = ms_mult(match[2]);
                            _resolution2 = +match[1] * mult;
                        }


                        xform[f.name] = {
                            to: function(v) {
                                return Math.round((v.getTime() - _start_time2)/_resolution2);
                            },
                            fro: function(v, state) {
                                return new Date(state.start*_resolution2 + _start_time2 + v * state.binwid*_resolution2);
                            }
                        };
                    }
                });
                // schema.metadata.forEach(function(m) {
                //     if(m.key === 'tbin') {
                //         var parts = m.value.split('_');
                //         _start_time = Date.parse(parts[0] + ' ' + parts[1]);
                //         var match;
                //         if((match = /^([0-9]+)([a-z]+)$/.exec(parts[2]))) {
                //             var mult = ms_mult(match[2]);
                //             _resolution = +match[1] * mult;
                //         }
                //     }
                // });
                return {fields, xform};
            });
        },
        augment_group: function(anchor, group) {
            function arg_printer(name /* ... */) {
                var args = Array.prototype.slice.call(arguments, 1);
                return function() {
                    return name + '(' + args.map(JSON.stringify).join(',') + ')';
                };
            }
            function dive_state(depth) {
                return {
                    depth: depth,
                    print: arg_printer('dive', depth)
                };
            }
            function time_state(start, binwid, len) {
                return {
                    start: start,
                    binwid: binwid,
                    len: len,
                    print: arg_printer('intseq', start, binwid, len)
                };
            }
            return Object.assign({}, group, {
                dive: function(depth) {
                    anchor.state = dive_state(depth);
                    return this;
                },
                // native interface
                intseq: function(start, binwid, len) { // ints
                    anchor.state = time_state(start, binwid, len);
                    return this;
                },
                // somewhat nicer interface
                time: function(start, binwid, len) { // Date, ms, number
                    start = start ? start.getTime() : 2;
                    binwid = binwid || _resolution2;
                    len = len || 10*365;
                    var startb = (start - _start_time2)/_resolution2,
                        widb = binwid/_resolution2;
                    return this.intseq(startb, widb, len);
                },
                categorical: function() {
                    group.categorical();
                    return this.dive(1);
                }
            });
        }
    };
};

xfilter.fgb_queries = function() {
    return {
        do_query: function(query_url, filters, group) {
            var query = {
                filter: {},
                groupby: [group.dimension]
            };
            for(var f in filters) {
                if(group && group.dimension === f)
                    continue;
                if(filters[f].type !== 'set')
                    throw new Error("don't know how to handle filter type " + filters[f].type);
                query.filter[f] = filters[f].target;
            }
            return d3.json(query_url('query'), {
                method: 'POST',
                headers: {
                    "Content-type": "application/json; charset=UTF-8"
                },
                body: JSON.stringify(query)
            });
        },
        unpack_result: function(result) {
            return result.map(function(pair) {
                return {key: pair[0], value: pair[1]};
            });
        },
        fetch_schema: function(query_url) {
            return d3.text(query_url('')).then(function(s) {
                var i = s.indexOf(' ');
                var count = +s.slice(0, i),
                    columns = JSON.parse(s.slice(i+1).replace(/'/g, '"'));
                return {
                    fields: columns.reduce(function(p, v) {
                        p[v] = true;
                        return p;
                    }, {}),
                    xform: {}
                };
            });
        }
    };
};

// define our own filter handler to avoid the dreaded filterFunction
xfilter.filter_handler = function (dimension, filters) {
    if (filters.length === 0) {
        dimension.filter(null);
    } else if (filters.length === 1 && !filters[0].isFiltered) {
        // single value and not a function-based filter
        dimension.filterExact(filters[0]);
    } else if (filters.length === 1 && filters[0].filterType === 'RangedFilter') {
        // single range-based filter
        dimension.filterRange(filters[0]);
    } else {
        // this is the case changed from core dc.js
        // filterMultiple does not exist in crossfilter
        dimension.filterMultiple(filters);
    }
    return filters;
};


return xfilter;
}
    if (typeof define === 'function' && define.amd) {
        define([], _xfilter);
    } else if (typeof module == "object" && module.exports) {
        module.exports = _xfilter();
    } else {
        this.xfilter = _xfilter();
    }
}
)();

//# sourceMappingURL=xfilter.js.map
