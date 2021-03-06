/*jslint node: true */
"use strict";
var constants = require('trustnote-pow-common/config/constants.js');
var conf = require('trustnote-pow-common/config/conf.js');
var db = require('trustnote-pow-common/db/db.js');
var mutex = require('trustnote-pow-common/base/mutex.js');

const AUTHOR_SIZE = 3 // "sig"
	+ 44  // pubkey
	+ 88; // signature

const TRANSFER_INPUT_SIZE = 0 // type: "transfer" omitted
	+ 44 // unit
	+ 8 // message_index
	+ 8; // output_index


function readLeastFundedAddresses(asset, wallet, handleFundedAddresses){
	db.query(
		"SELECT address, SUM(amount) AS total \n\
		FROM my_addresses CROSS JOIN outputs USING(address) \n\
		CROSS JOIN units USING(unit) \n\
		WHERE wallet=? AND is_stable=1 AND sequence='good' AND is_spent=0 AND "+(asset ? "asset="+db.escape(asset) : "asset IS NULL")+" \n\
			AND NOT EXISTS ( \n\
				SELECT * FROM units CROSS JOIN unit_authors USING(unit) \n\
				WHERE is_stable=0 AND unit_authors.address=outputs.address AND definition_chash IS NOT NULL \n\
			) \n\
		GROUP BY address ORDER BY SUM(amount) LIMIT 15",
		[wallet],
		function(rows){
			handleFundedAddresses(rows.map(row => row.address));
		}
	);
}

function determineCountOfOutputs(asset, wallet, handleCount){
	db.query(
		"SELECT COUNT(*) AS count FROM my_addresses CROSS JOIN outputs USING(address) JOIN units USING(unit) \n\
		WHERE wallet=? AND is_spent=0 AND "+(asset ? "asset="+db.escape(asset) : "asset IS NULL")+" AND is_stable=1 AND sequence='good'",
		[wallet],
		function(rows){
			handleCount(rows[0].count);
		}
	);
}

function readDestinationAddress(wallet, handleAddress){
	db.query("SELECT address FROM my_addresses WHERE wallet=? ORDER BY is_change DESC, address_index ASC LIMIT 1", [wallet], rows => {
		if (rows.length === 0)
			throw Error('no dest address');
		handleAddress(rows[0].address);
	});
}

function consolidate(wallet, signer){
	var asset = null;
	mutex.lock(['consolidate'], unlock => {
		determineCountOfOutputs(asset, wallet, count => {
			console.log(count+' unspent outputs');
			if (count <= conf.MAX_UNSPENT_OUTPUTS)
				return unlock();
			let count_to_spend = Math.min(count - conf.MAX_UNSPENT_OUTPUTS + 1, constants.MAX_INPUTS_PER_PAYMENT_MESSAGE - 1);
			readLeastFundedAddresses(asset, wallet, arrAddresses => {
				db.query(
					"SELECT address, unit, message_index, output_index, amount \n\
					FROM outputs \n\
					CROSS JOIN units USING(unit) \n\
					WHERE address IN(?) AND is_stable=1 AND sequence='good' AND is_spent=0 AND "+(asset ? "asset="+db.escape(asset) : "asset IS NULL")+" \n\
						AND NOT EXISTS ( \n\
							SELECT * FROM units CROSS JOIN unit_authors USING(unit) \n\
							WHERE is_stable=0 AND unit_authors.address=outputs.address AND definition_chash IS NOT NULL \n\
						) \n\
					ORDER BY amount LIMIT ?",
					[arrAddresses, count_to_spend],
					function(rows){
						
						// if all inputs are so small that they don't pay even for fees, add one more large input
						function addLargeInputIfNecessary(onDone){
							var target_amount = 1000 + TRANSFER_INPUT_SIZE*rows.length + AUTHOR_SIZE*arrAddresses.length;
							if (input_amount > target_amount)
								return onDone();
							target_amount += TRANSFER_INPUT_SIZE + AUTHOR_SIZE;
							db.query(
								"SELECT address, unit, message_index, output_index, amount \n\
								FROM my_addresses \n\
								CROSS JOIN outputs USING(address) \n\
								CROSS JOIN units USING(unit) \n\
								WHERE wallet=? AND is_stable=1 AND sequence='good' \n\
									AND is_spent=0 AND "+(asset ? "asset="+db.escape(asset) : "asset IS NULL")+" \n\
									AND NOT EXISTS ( \n\
										SELECT * FROM units CROSS JOIN unit_authors USING(unit) \n\
										WHERE is_stable=0 AND unit_authors.address=outputs.address AND definition_chash IS NOT NULL \n\
									) \n\
									AND amount>? AND unit NOT IN(?) \n\
								LIMIT 1",
								[wallet, target_amount - input_amount, Object.keys(assocUsedUnits)],
								large_rows => {
									if (large_rows.length === 0)
										return onDone("no large input found");
									let row = large_rows[0];
									assocUsedAddresses[row.address] = true;
									input_amount += row.amount;
									arrInputs.push({
										unit: row.unit,
										message_index: row.message_index,
										output_index: row.output_index
									});
									onDone();
								}
							);
						}
						
						var assocUsedAddresses = {};
						var assocUsedUnits = {};
						var input_amount = 0;
						var arrInputs = rows.map(row => {
							assocUsedAddresses[row.address] = true;
							assocUsedUnits[row.unit] = true;
							input_amount += row.amount;
							return {
								unit: row.unit,
								message_index: row.message_index,
								output_index: row.output_index
							};
						});
						addLargeInputIfNecessary(err => {
							if (err){
								console.log("consolidation failed: "+err);
								return unlock();
							}
							let arrUsedAddresses = Object.keys(assocUsedAddresses);
							readDestinationAddress(wallet, dest_address => {
								var composer = require('trustnote-pow-common/composer.js');
								composer.composeJoint({
									paying_addresses: arrUsedAddresses,
									outputs: [{address: dest_address, amount: 0}],
									inputs: arrInputs,
									input_amount: input_amount,
									earned_headers_commission_recipients: [{address: dest_address, earned_headers_commission_share: 100}],
									callbacks: composer.getSavingCallbacks({
										ifOk: function(objJoint){
											var network = require('trustnote-pow-common/network.js');
											network.broadcastJoint(objJoint);
											unlock();
											consolidate(wallet, signer); // do more if something's left
										},
										ifError: function(err){
											throw Error('failed to compose consolidation transaction: '+err);
										},
										ifNotEnoughFunds: function(err){
											throw Error('not enough funds to compose consolidation transaction: '+err);
										}
									}),
									signer: signer
								});
							});
						});
					}
				);
			});
		});
	});
}

exports.consolidate = consolidate;


