/**
 * @NApiVersion 2.x
 * @NScriptType ClientScript
 * Class and Building must be available on the header and editable line sublists.
 * Department is validated on all transactions except journal entries.
 */
define(['N/search', 'N/log'], function (search, log) {
    var sublists = ['line', 'expense', 'item'];
    var journalTypes = ['journalentry', 'intercompanyjournalentry',
        'advintercompanyjournalentry', 'statisticaljournalentry'];
    var updating = false;
    var subsidiaryCache = {};

    function getValue(field) {
        if (Array.isArray(field)) { field = field[0]; }
        return field && typeof field === 'object' ? field.value : (field || '');
    }

    // With no sublist, populate the header. Otherwise populate the selected line.
    function setDefaults(rec, sublist, overwrite) {
        var subsidiary = sublist ? rec.getCurrentSublistValue({
            sublistId: sublist, fieldId: 'subsidiary'
        }) : '';
        subsidiary = subsidiary || rec.getValue({ fieldId: 'subsidiary' });
        if (!subsidiary) { return; }
        if (!subsidiaryCache[subsidiary]) {
            subsidiaryCache[subsidiary] = search.lookupFields({
                type: search.Type.SUBSIDIARY, id: subsidiary,
                columns: ['custrecord_class_campus', 'custrecord_building']
            });
        }
        var defaults = subsidiaryCache[subsidiary];
        var fields = ['class', 'cseg_building'];
        var values = [getValue(defaults.custrecord_class_campus), getValue(defaults.custrecord_building)];
        for (var i = 0; i < fields.length; i++) {
            if (!overwrite && !values[i]) { continue; }
            var options = { fieldId: fields[i], value: values[i], ignoreFieldChange: true };
            if (sublist) {
                options.sublistId = sublist;
                if (overwrite || !rec.getCurrentSublistValue({ sublistId: sublist, fieldId: fields[i] })) {
                    rec.setCurrentSublistValue(options);
                }
            } else if (overwrite || !rec.getValue({ fieldId: fields[i] })) {
                rec.setValue(options);
            }
        }
    }

    // A line counts as "in use" only once it has an item or account.
    function currentLineHasData(rec, sublist) {
        return !!(rec.getCurrentSublistValue({ sublistId: sublist, fieldId: 'item' }) ||
            rec.getCurrentSublistValue({ sublistId: sublist, fieldId: 'account' }));
    }

    // Shared by fieldChanged, postSourcing and lineInit; no mandatory validation here.
    function populateSegments(context) {
        if (updating) { return; }
        var rec = context.currentRecord;
        var sublist = context.sublistId;
        var field = context.fieldId;
        var headerChanged = !sublist && field === 'subsidiary';
        var lineChanged = sublists.indexOf(sublist) !== -1 &&
            (!field || ['subsidiary', 'item', 'account'].indexOf(field) !== -1);
        if (!headerChanged && !lineChanged) { return; }

        try {
            updating = true;
            if (headerChanged) {
                // A subsidiary change replaces Class/Building, including old defaults.
                setDefaults(rec, null, true);
                for (var s = 0; s < sublists.length; s++) {
                    var count = rec.getLineCount({ sublistId: sublists[s] });
                    for (var line = 0; line < count; line++) {
                        rec.selectLine({ sublistId: sublists[s], line: line });
                        setDefaults(rec, sublists[s], true);
                        rec.commitLine({ sublistId: sublists[s] });
                    }
                }
            } else {
                // Don't touch an empty line (e.g. the blank line NetSuite opens after a commit),
                // otherwise it becomes "dirty" and blocks save.
                if (!currentLineHasData(rec, sublist)) { return; }

                // New lines receive defaults; selecting an existing line only fills blanks.
                setDefaults(rec, sublist, field === 'subsidiary');
            }
        } catch (error) {
            log.error({ title: 'Segment defaulting failed', details: error });
            alert('Unable to populate Class/Building: ' + error.message);
        } finally {
            updating = false;
        }
    }

    // At save, fill blank segments from subsidiary defaults before mandatory validation.
    function saveRecord(context) {
        var rec = context.currentRecord;
        var accounts = {}, items = {}, warnings = [];
        var isJournal = journalTypes.indexOf(rec.type) !== -1;
        var fields = isJournal ? ['class', 'cseg_building'] : ['department', 'class', 'cseg_building'];
        var labels = isJournal ? ['Campus (Class)', 'Building'] : ['Department', 'Campus (Class)', 'Building'];
        try {
            updating = true;
            subsidiaryCache = {}; // Refresh defaults when saving.
            setDefaults(rec, null, false);
            for (var d = 0; d < sublists.length; d++) {
                var defaultSublist = sublists[d];
                var defaultCount = rec.getLineCount({ sublistId: defaultSublist });
                for (var n = 0; n < defaultCount; n++) {
                    if (!rec.getSublistValue({ sublistId: defaultSublist, fieldId: 'class', line: n }) ||
                            !rec.getSublistValue({ sublistId: defaultSublist, fieldId: 'cseg_building', line: n })) {
                        rec.selectLine({ sublistId: defaultSublist, line: n });
                        setDefaults(rec, defaultSublist, false);
                        rec.commitLine({ sublistId: defaultSublist });
                    }
                }
            }

            // Header Department is required on every transaction except journal entries.
            if (!isJournal && !rec.getValue({ fieldId: 'department' })) {
                alert('Please enter Department on the transaction header.');
                return false;
            }

            for (var s = 0; s < sublists.length; s++) {
                var sublist = sublists[s];
                var count = rec.getLineCount({ sublistId: sublist });
                for (var line = 0; line < count; line++) {
                    var accountId = rec.getSublistValue({ sublistId: sublist, fieldId: 'account', line: line });
                    if (!accountId && sublist === 'item') {
                        var itemId = rec.getSublistValue({ sublistId: sublist, fieldId: 'item', line: line });
                        if (!itemId || Number(itemId) < 0) { continue; }
                        if (!items[itemId]) {
                            items[itemId] = search.lookupFields({ type: search.Type.ITEM, id: itemId,
                                columns: ['incomeaccount', 'expenseaccount', 'assetaccount'] });
                        }
                        var item = items[itemId];
                        if (['invoice', 'creditmemo', 'cashsale', 'cashrefund', 'salesorder',
                                'estimate', 'returnauthorization'].indexOf(rec.type) !== -1) {
                            accountId = getValue(item.incomeaccount);
                        } else if (['vendorbill', 'vendorcredit', 'purchaseorder', 'vendorreturnauthorization',
                                'check', 'creditcardcharge', 'creditcardrefund'].indexOf(rec.type) !== -1) {
                            accountId = getValue(item.assetaccount) || getValue(item.expenseaccount);
                        } else {
                            throw new Error('Item account mapping is not configured for ' + rec.type + '.');
                        }
                    }
                    if (!accountId) { continue; }
                    if (!accounts[accountId]) {
                        accounts[accountId] = search.lookupFields({ type: search.Type.ACCOUNT, id: accountId,
                            columns: ['type', 'number'] });
                    }
                    var account = accounts[accountId];
                    var startsWith17 = String(account.number || '').trim().indexOf('17') === 0;
                    if (startsWith17 || ['Income', 'COGS', 'Expense', 'OthExpense', 'OthIncome',
                            'FixedAsset'].indexOf(getValue(account.type)) !== -1) {
                        var missing = [];
                        for (var f = 0; f < fields.length; f++) {
                            if (!rec.getSublistValue({ sublistId: sublist, fieldId: fields[f], line: line })) {
                                missing.push(labels[f]);
                            }
                        }
                        if (missing.length) {
                            alert('Please enter ' + missing.join(', ') + ' on ' + sublist + ' line ' + (line + 1) + '.');
                            return false;
                        }
                    }
                    // Preserve the original non-blocking subsidiary 8 name warning at save.
                    var subsidiary = rec.getSublistValue({ sublistId: sublist, fieldId: 'subsidiary', line: line }) ||
                        rec.getValue({ fieldId: 'subsidiary' });
                    if (startsWith17 && String(subsidiary) === '8' &&
                            ['vendorbill', 'vendorcredit', 'journalentry'].indexOf(rec.type) !== -1 &&
                            !rec.getSublistValue({ sublistId: sublist, fieldId: 'entity', line: line })) {
                        warnings.push(sublist + ' line ' + (line + 1));
                    }
                }
            }
            if (warnings.length) {
                alert('Customer/Project/Name Empty on ' + warnings.join(', ') + '. Click OK to continue.');
            }
            return true;
        } catch (error) {
            log.error({ title: 'Save validation failed', details: error });
            alert('Unable to validate transaction lines: ' + error.message);
            return false;
        } finally {
            updating = false;
        }
    }

    return {
        fieldChanged: populateSegments,
        postSourcing: populateSegments,
        lineInit: populateSegments,
        saveRecord: saveRecord
    };
});